// Адаптер локальной модели Ollama. Модель работает локально; в интернет уходят только поисковые запросы
// (SearXNG или Ollama Web Search). Источники берутся только из результатов поиска,
// модель может лишь сослаться на их номера — ссылкам из её текста сервер не доверяет.

import type { ArticleFocus, Block, Verdict } from "../../../shared/contract.ts";
import { VERDICTS } from "../../../shared/contract.ts";
import { ModelError } from "../llm/errors.ts";
import { EXTRACT_WITH_QUERIES_SCHEMA, EXTRACT_WITH_QUERIES_SYSTEM, QUERY_SCHEMA, QUERY_SYSTEM, SUMMARY_SYSTEM, VERDICT_SCHEMA, VERDICT_SYSTEM, extractInput, extractSystem } from "../llm/prompts.ts";
import { DEFAULT_RETRY, type RetryPolicy, parseJson, withRetry } from "../llm/retry.ts";
import type { ArticleContext, CheckInput, CheckOutcome, FactChecker, StepCallback, SummaryInput } from "../llm/types.ts";
import { type RawClaim, cleanQueries } from "../pipeline/claims.ts";
import type { Citation, SourceAssessment } from "../pipeline/evidence.ts";
import type { SearchProvider } from "../search/types.ts";

const CHAT_TIMEOUT_MS = 300_000;
const MAX_SOURCES = 8;
const SNIPPET_CHARS = 1500;

export interface OllamaOptions {
  host: string;
  model: string;
  numCtx: number;
  search: SearchProvider;
  /** Сколько поисковых запросов составлять на одно утверждение. */
  queriesPerClaim: number;
  retry?: RetryPolicy;
  fetch?: typeof fetch;
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

  async extractClaims(article: ArticleContext, blocks: Block[], signal?: AbortSignal, focus?: ArticleFocus | null): Promise<RawClaim[]> {
    const system = extractSystem(EXTRACT_WITH_QUERIES_SYSTEM, focus);
    const parsed = parseJson(await this.chat(system, extractInput(article, blocks, focus), EXTRACT_WITH_QUERIES_SCHEMA, signal)) as { claims?: unknown };
    if (!Array.isArray(parsed?.claims)) throw new ModelError("invalid_response", "В ответе нет массива claims");
    return parsed.claims as RawClaim[];
  }

  async checkClaim(input: CheckInput, signal?: AbortSignal, onStep?: StepCallback): Promise<CheckOutcome> {
    const context = {
      claim: input.claim,
      kind: input.kind,
      article: { title: input.article.title, publishedAt: input.article.publishedAt, site: hostOf(input.article.url) },
      fragments: input.context,
    };
    // Запросы обычно уже составлены при извлечении утверждений; отдельный вызов модели — только если их нет.
    let queries = cleanQueries(input.searchQueries).slice(0, this.opts.queriesPerClaim);
    if (queries.length === 0) {
      onStep?.("queries");
      const q = parseJson(await this.chat(QUERY_SYSTEM, JSON.stringify(context), QUERY_SCHEMA, signal)) as { queries?: unknown };
      queries = cleanQueries(q?.queries).slice(0, this.opts.queriesPerClaim);
    }
    if (queries.length === 0) queries = [input.claim.slice(0, 300)];
    onStep?.("search", queries);

    // Запросы одного утверждения ищутся параллельно; порядок источников — по порядку запросов.
    const results = await Promise.all(queries.map((query) => this.opts.search.search(query, signal)));
    const citations: Citation[] = [];
    const seen = new Set<string>();
    let index = 0;
    for (const list of results) {
      for (const r of list) {
        const current = index++;
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        citations.push({ url: r.url, title: r.title, annotationIndex: current, citedText: r.content?.slice(0, SNIPPET_CHARS) ?? null });
      }
    }
    citations.splice(MAX_SOURCES);

    if (citations.length === 0) {
      return { verdict: "insufficient", explanation: "Поиск не нашёл источников по этому утверждению.", sources: [], citations, interactionId: null, searchQueries: queries };
    }
    onStep?.("verdict", queries);
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

/** Состояние локальной Ollama и поиска для /api/health: запущена ли, скачана ли модель, доступен ли поиск. */
export async function ollamaProblem(opts: Pick<OllamaOptions, "host" | "model" | "search" | "fetch">): Promise<string | null> {
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
  return opts.search.problem();
}
