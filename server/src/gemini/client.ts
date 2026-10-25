// Адаптер Gemini Interactions API. Проверка claim — два вызова: поиск с Google Search (ссылки берутся
// только из его аннотаций url_citation) и вывод вердикта структурированным JSON без инструментов.
// Так результат не зависит от того, поддерживает ли модель schema и grounding в одном запросе.

import { GoogleGenAI } from "@google/genai";
import type { AnalysisStats, Block, ClaimKind, Verdict } from "../../../shared/contract.ts";
import { VERDICTS } from "../../../shared/contract.ts";
import type { RawClaim } from "../pipeline/claims.ts";
import { type Citation, type InteractionLike, type SourceAssessment, extractCitations, outputText } from "../pipeline/evidence.ts";
import { GeminiError, classifyError } from "./errors.ts";
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, SEARCH_SYSTEM, SUMMARY_SYSTEM, VERDICT_SCHEMA, VERDICT_SYSTEM } from "./prompts.ts";

export interface ArticleContext {
  title: string | null;
  publishedAt: string | null;
  url: string;
}

export interface CheckInput {
  claim: string;
  kind: ClaimKind;
  /** Тексты блоков, где встречается утверждение. */
  context: string[];
  article: ArticleContext;
}

export interface CheckOutcome {
  verdict: Verdict;
  explanation: string;
  sources: SourceAssessment[];
  citations: Citation[];
  interactionId: string | null;
  searchQueries: string[];
}

export interface SummaryInput {
  stats: AnalysisStats;
  preliminary: boolean;
  claims: { claim: string; verdict: Verdict | null; status: string; explanation: string | null }[];
}

/** Всё, что конвейер требует от модели. В тестах подменяется заглушкой; в работе — только GeminiFactChecker. */
export interface FactChecker {
  extractClaims(article: ArticleContext, blocks: Block[], signal?: AbortSignal): Promise<RawClaim[]>;
  checkClaim(input: CheckInput, signal?: AbortSignal): Promise<CheckOutcome>;
  summarize(input: SummaryInput, signal?: AbortSignal): Promise<string | null>;
}

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 2000, maxDelayMs: 60_000 };
const CALL_TIMEOUT_MS = 120_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

/** Повтор с экспоненциальной задержкой для 429/5xx/таймаутов; учитывает подсказку retryDelay от Google. */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, apiKey: string | null, signal?: AbortSignal): Promise<T> {
  let last: GeminiError | null = null;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted) throw e;
      last = classifyError(e, apiKey);
      if (!last.retryable || attempt === policy.attempts) throw last;
      const backoff = policy.baseDelayMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
      await sleep(Math.min(policy.maxDelayMs, Math.max(backoff, last.retryAfterMs ?? 0)), signal);
    }
  }
  throw last ?? new GeminiError("unknown", "retry loop exhausted");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Иногда JSON приходит в ```-блоке.
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ниже */
      }
    }
    throw new GeminiError("invalid_response", "Ответ модели не является JSON");
  }
}

export class GeminiFactChecker implements FactChecker {
  private readonly ai: GoogleGenAI;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly retry: RetryPolicy;

  constructor(apiKey: string, model: string, retry: RetryPolicy = DEFAULT_RETRY) {
    this.ai = new GoogleGenAI({ apiKey });
    this.apiKey = apiKey;
    this.model = model;
    this.retry = retry;
  }

  private create(params: Record<string, unknown>, signal?: AbortSignal): Promise<InteractionLike> {
    return withRetry(
      async () => {
        const interaction = (await this.ai.interactions.create(
          { model: this.model, store: false, ...params } as Parameters<GoogleGenAI["interactions"]["create"]>[0],
          { timeout_ms: CALL_TIMEOUT_MS, retries: { strategy: "none" }, ...(signal ? { signal } : {}) },
        )) as InteractionLike & { status?: string };
        if (interaction.status && interaction.status !== "completed") {
          throw new GeminiError("invalid_response", `Interaction status: ${interaction.status}`);
        }
        return interaction;
      },
      this.retry,
      this.apiKey,
      signal,
    );
  }

  async extractClaims(article: ArticleContext, blocks: Block[], signal?: AbortSignal): Promise<RawClaim[]> {
    const input = JSON.stringify({
      title: article.title,
      publishedAt: article.publishedAt,
      blocks: blocks.map((b) => ({ id: b.id, type: b.type, text: b.text })),
    });
    const interaction = await this.create(
      {
        system_instruction: EXTRACT_SYSTEM,
        input,
        response_format: { type: "text", mime_type: "application/json", schema: EXTRACT_SCHEMA },
        generation_config: { temperature: 0 },
      },
      signal,
    );
    const parsed = parseJson(outputText(interaction)) as { claims?: unknown };
    if (!Array.isArray(parsed?.claims)) throw new GeminiError("invalid_response", "В ответе нет массива claims");
    return parsed.claims as RawClaim[];
  }

  async checkClaim(input: CheckInput, signal?: AbortSignal): Promise<CheckOutcome> {
    const site = (() => {
      try {
        return new URL(input.article.url).hostname;
      } catch {
        return null;
      }
    })();
    const search = await this.create(
      {
        system_instruction: SEARCH_SYSTEM,
        input: [
          `Утверждение: ${input.claim}`,
          `Тип: ${input.kind}`,
          `Статья: «${input.article.title ?? "без заголовка"}», сайт ${site ?? "неизвестен"}, дата публикации ${input.article.publishedAt ?? "неизвестна"}.`,
          `Фрагменты статьи:\n${input.context.map((c) => `> ${c}`).join("\n")}`,
        ].join("\n"),
        tools: [{ type: "google_search" }],
      },
      signal,
    );
    const citations = extractCitations(search);
    const report = outputText(search);
    const searchQueries = (search.steps ?? []).flatMap((s) => {
      const step = s as { type?: string; arguments?: { queries?: unknown } };
      return step?.type === "google_search_call" && Array.isArray(step.arguments?.queries) ? (step.arguments!.queries as string[]) : [];
    });

    const verdictCall = await this.create(
      {
        system_instruction: VERDICT_SYSTEM,
        input: JSON.stringify({
          claim: input.claim,
          kind: input.kind,
          report,
          sources: citations.map((c, i) => ({ index: i + 1, title: c.title, url: c.url, citedText: c.citedText })),
        }),
        response_format: { type: "text", mime_type: "application/json", schema: VERDICT_SCHEMA },
        generation_config: { temperature: 0 },
      },
      signal,
    );
    const parsed = parseJson(outputText(verdictCall)) as { verdict?: unknown; explanation?: unknown; sources?: unknown };
    if (!VERDICTS.includes(parsed?.verdict as Verdict)) throw new GeminiError("invalid_response", "Неизвестный вердикт в ответе");
    return {
      verdict: parsed.verdict as Verdict,
      explanation: typeof parsed.explanation === "string" ? parsed.explanation.trim().slice(0, 1500) : "",
      sources: Array.isArray(parsed.sources) ? (parsed.sources as SourceAssessment[]) : [],
      citations,
      interactionId: search.id ?? null,
      searchQueries,
    };
  }

  async summarize(input: SummaryInput, signal?: AbortSignal): Promise<string | null> {
    const interaction = await this.create(
      { system_instruction: SUMMARY_SYSTEM, input: JSON.stringify(input), generation_config: { temperature: 0 } },
      signal,
    );
    const text = outputText(interaction).trim();
    return text ? text.slice(0, 1200) : null;
  }
}
