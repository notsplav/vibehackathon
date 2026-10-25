// Адаптер Gemini Interactions API. Проверка claim — два вызова: поиск с Google Search (ссылки берутся
// только из его аннотаций url_citation) и вывод вердикта структурированным JSON без инструментов.
// Так результат не зависит от того, поддерживает ли модель schema и grounding в одном запросе.

import { GoogleGenAI } from "@google/genai";
import type { Block, Verdict } from "../../../shared/contract.ts";
import { VERDICTS } from "../../../shared/contract.ts";
import { ModelError } from "../llm/errors.ts";
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, SEARCH_SYSTEM, SUMMARY_SYSTEM, VERDICT_SCHEMA, VERDICT_SYSTEM } from "../llm/prompts.ts";
import { DEFAULT_RETRY, type RetryPolicy, parseJson, withRetry } from "../llm/retry.ts";
import type { ArticleContext, CheckInput, CheckOutcome, FactChecker, SummaryInput } from "../llm/types.ts";
import type { RawClaim } from "../pipeline/claims.ts";
import { type InteractionLike, type SourceAssessment, extractCitations, outputText } from "../pipeline/evidence.ts";

const CALL_TIMEOUT_MS = 120_000;

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
          throw new ModelError("invalid_response", `Interaction status: ${interaction.status}`);
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
    if (!Array.isArray(parsed?.claims)) throw new ModelError("invalid_response", "В ответе нет массива claims");
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
    if (!VERDICTS.includes(parsed?.verdict as Verdict)) throw new ModelError("invalid_response", "Неизвестный вердикт в ответе");
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
