// Адаптер локальной модели Ollama и Ollama Web Search. Модель работает локально; в интернет уходят
// только поисковые запросы (на ollama.com). Источники берутся только из результатов поиска,
// модель может лишь сослаться на их номера — ссылкам из её текста сервер не доверяет.

import type { Block, Verdict } from "../../../shared/contract.ts";
import { VERDICTS } from "../../../shared/contract.ts";
import { ModelError } from "../llm/errors.ts";
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, QUERY_SCHEMA, QUERY_SYSTEM, SUMMARY_SYSTEM, VERDICT_SCHEMA, VERDICT_SYSTEM } from "../llm/prompts.ts";
import { DEFAULT_RETRY, type RetryPolicy, parseJson, withRetry } from "../llm/retry.ts";
import type { ArticleContext, CheckInput, CheckOutcome, FactChecker, SummaryInput } from "../llm/types.ts";
import type { RawClaim } from "../pipeline/claims.ts";
import type { Citation, SourceAssessment } from "../pipeline/evidence.ts";

export const WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const CHAT_TIMEOUT_MS = 300_000;
const SEARCH_TIMEOUT_MS = 30_000;
const RESULTS_PER_QUERY = 5;
const MAX_QUERIES = 3;
const MAX_SOURCES = 8;
const SNIPPET_CHARS = 1500;

export interface OllamaOptions {
  host: string;
  model: string;
  /** Ключ Ollama Web Search; отправляется только на ollama.com, не в локальную модель. */
  apiKey: string | null;
  numCtx: number;
  retry?: RetryPolicy;
  fetch?: typeof fetch;
}

interface SearchResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

async function httpError(res: Response): Promise<Error & { status: number }> {
  const body = (await res.text().catch(() => "")).slice(0, 300);
  return Object.assign(new Error(`HTTP ${res.status}: ${body}`), { status: res.status });
}

export class OllamaFactChecker implements FactChecker {
  private readonly opts: OllamaOptions;
  private readonly retry: RetryPolicy;
  private readonly fetch: typeof fetch;

  constructor(opts: OllamaOptions) {
    this.opts = opts;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.fetch = opts.fetch ?? fetch;
  }

  private timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  }

  /** Один ответ локальной модели; при `schema` — JSON по схеме (structured outputs Ollama). */
  async chat(system: string, user: string, schema: object | null, signal?: AbortSignal): Promise<string> {
    return withRetry(
      async () => {
        const res = await this.fetch(new URL("/api/chat", this.opts.host), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.opts.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            stream: false,
            think: false,
            ...(schema ? { format: schema } : {}),
            options: { temperature: 0, num_ctx: this.opts.numCtx },
            keep_alive: "15m",
          }),
          signal: this.timeoutSignal(CHAT_TIMEOUT_MS, signal),
        });
        if (res.status === 404) throw new ModelError("not_configured", `Модель ${this.opts.model} не найдена в Ollama`, 404);
        if (!res.ok) throw await httpError(res);
        const data = (await res.json()) as { message?: { content?: unknown } };
        if (typeof data?.message?.content !== "string") throw new ModelError("invalid_response", "В ответе Ollama нет message.content");
        return data.message.content;
      },
      this.retry,
      null,
      signal,
    );
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const key = this.opts.apiKey;
    if (!key) throw new ModelError("auth", "OLLAMA_API_KEY не задан");
    return withRetry(
      async () => {
        const res = await this.fetch(WEB_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, max_results: RESULTS_PER_QUERY }),
          signal: this.timeoutSignal(SEARCH_TIMEOUT_MS, signal),
        });
        if (!res.ok) throw await httpError(res);
        const data = (await res.json()) as { results?: unknown };
        return Array.isArray(data?.results) ? (data.results as SearchResult[]) : [];
      },
      this.retry,
      key,
      signal,
    );
  }

  async extractClaims(article: ArticleContext, blocks: Block[], signal?: AbortSignal): Promise<RawClaim[]> {
    const input = JSON.stringify({
      title: article.title,
      publishedAt: article.publishedAt,
      blocks: blocks.map((b) => ({ id: b.id, type: b.type, text: b.text })),
    });
    const parsed = parseJson(await this.chat(EXTRACT_SYSTEM, input, EXTRACT_SCHEMA, signal)) as { claims?: unknown };
    if (!Array.isArray(parsed?.claims)) throw new ModelError("invalid_response", "В ответе нет массива claims");
    return parsed.claims as RawClaim[];
  }

  async checkClaim(input: CheckInput, signal?: AbortSignal): Promise<CheckOutcome> {
    const context = {
      claim: input.claim,
      kind: input.kind,
      article: { title: input.article.title, publishedAt: input.article.publishedAt, site: hostOf(input.article.url) },
      fragments: input.context,
    };
    const q = parseJson(await this.chat(QUERY_SYSTEM, JSON.stringify(context), QUERY_SCHEMA, signal)) as { queries?: unknown };
    const queries = (Array.isArray(q?.queries) ? q.queries : [])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 2)
      .map((x) => x.trim().slice(0, 300))
      .slice(0, MAX_QUERIES);
    if (queries.length === 0) queries.push(input.claim.slice(0, 300));

    const citations: Citation[] = [];
    const seen = new Set<string>();
    let index = 0;
    for (const query of queries) {
      for (const r of await this.search(query, signal)) {
        const current = index++;
        if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url) || seen.has(r.url)) continue;
        seen.add(r.url);
        citations.push({
          url: r.url,
          title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 300) : null,
          annotationIndex: current,
          citedText: typeof r.content === "string" ? r.content.slice(0, SNIPPET_CHARS) : null,
        });
      }
      if (citations.length >= MAX_SOURCES) break;
    }
    citations.splice(MAX_SOURCES);

    if (citations.length === 0) {
      return { verdict: "insufficient", explanation: "Поиск не нашёл источников по этому утверждению.", sources: [], citations, interactionId: null, searchQueries: queries };
    }
    const verdictInput = JSON.stringify({
      ...context,
      sources: citations.map((c, i) => ({ index: i + 1, title: c.title, url: c.url, content: c.citedText })),
    });
    const parsed = parseJson(await this.chat(VERDICT_SYSTEM, verdictInput, VERDICT_SCHEMA, signal)) as {
      verdict?: unknown;
      explanation?: unknown;
      sources?: unknown;
    };
    if (!VERDICTS.includes(parsed?.verdict as Verdict)) throw new ModelError("invalid_response", "Неизвестный вердикт в ответе");
    return {
      verdict: parsed.verdict as Verdict,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation.trim().slice(0, 1500) : "",
      sources: Array.isArray(parsed.sources) ? (parsed.sources as SourceAssessment[]) : [],
      citations,
      interactionId: null,
      searchQueries: queries,
    };
  }

  async summarize(input: SummaryInput, signal?: AbortSignal): Promise<string | null> {
    const text = (await this.chat(SUMMARY_SYSTEM, JSON.stringify(input), null, signal)).trim();
    return text ? text.slice(0, 1200) : null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Состояние локальной Ollama для /api/health: запущена ли и скачана ли модель. */
export async function ollamaProblem(opts: Pick<OllamaOptions, "host" | "model" | "apiKey" | "fetch">): Promise<string | null> {
  const f = opts.fetch ?? fetch;
  let models: string[];
  try {
    const res = await f(new URL("/api/tags", opts.host), { signal: AbortSignal.timeout(1500) });
    const data = (await res.json()) as { models?: { name?: string }[] };
    models = (data.models ?? []).map((m) => m.name ?? "");
  } catch {
    return `Ollama не запущена на ${opts.host}: выполните ollama serve.`;
  }
  const wanted = opts.model.includes(":") ? opts.model : `${opts.model}:latest`;
  if (!models.includes(wanted)) return `Модель ${opts.model} не скачана: выполните ollama pull ${opts.model}.`;
  if (!opts.apiKey) return "OLLAMA_API_KEY не задан: без веб-поиска утверждения нельзя проверить по источникам.";
  return null;
}
