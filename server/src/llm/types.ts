// Что конвейер требует от модели. Реализации: GeminiFactChecker и OllamaFactChecker; в тестах — заглушка.

import type { AnalysisStats, ArticleFocus, Block, CheckStep, ClaimKind, Verdict } from "../../../shared/contract.ts";
import type { RawClaim } from "../pipeline/claims.ts";
import type { Citation, SourceAssessment } from "../pipeline/evidence.ts";

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
  /** Запросы, составленные при извлечении; если их нет, провайдер составит их сам. */
  searchQueries?: string[];
}

export interface CheckOutcome {
  verdict: Verdict;
  explanation: string;
  /** Номера источников из `citations`, на которые сослалась модель. */
  sources: SourceAssessment[];
  /** Источники только из метаданных поиска (grounding Gemini или результаты Ollama Web Search). */
  citations: Citation[];
  interactionId: string | null;
  searchQueries: string[];
}

export interface SummaryInput {
  stats: AnalysisStats;
  preliminary: boolean;
  claims: { claim: string; verdict: Verdict | null; status: string; explanation: string | null }[];
}

/** Сообщает конвейеру, на каком шаге проверка утверждения (для живого прогресса в панели). */
export type StepCallback = (step: CheckStep, queries?: string[]) => void;

export interface FactChecker {
  /** `focus` — проверка выделенного фрагмента: утверждения только из него, остальные блоки — контекст. */
  extractClaims(article: ArticleContext, blocks: Block[], signal?: AbortSignal, focus?: ArticleFocus | null): Promise<RawClaim[]>;
  checkClaim(input: CheckInput, signal?: AbortSignal, onStep?: StepCallback): Promise<CheckOutcome>;
  summarize(input: SummaryInput, signal?: AbortSignal): Promise<string | null>;
}
