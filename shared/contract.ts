// Общий контракт между расширением и локальным сервером (ТЗ, разделы 3, 6 и 8).
// Изменения здесь затрагивают всю команду: согласуйте их и отразите в docs/decisions.md.

export const SCHEMA_VERSION = 1;

// --- Извлечённая статья ---

export type Quality = "confirmed" | "plausible" | "unknown";

export interface SourcedValue<T> {
  value: T;
  /** Откуда взято значение, например "jsonld.datePublished" или "meta.article:published_time". */
  source: string;
  quality: Quality;
}

export interface Author {
  name: string;
  type: "person" | "organization";
  url?: string;
  source: string;
  quality: Quality;
}

export interface ArticleMetadata {
  title: string | null;
  subtitle: string | null;
  authors: Author[];
  publishedAt: SourcedValue<string> | null;
  modifiedAt: SourcedValue<string> | null;
}

export type BlockType = "title" | "subtitle" | "heading" | "paragraph" | "list_item" | "quote" | "caption";

export interface BlockLink {
  href: string;
  text: string;
}

export interface Block {
  /** Стабильный в пределах одного извлечения идентификатор: "b1", "b2", ... */
  id: string;
  type: BlockType;
  /** Порядок чтения, начиная с 1. */
  order: number;
  text: string;
  links: BlockLink[];
  /** Задан, если длинный блок разделён по границам предложений. */
  parentBlockId?: string;
}

export type ExtractionErrorCode = "not_article" | "empty_page" | "low_confidence";

export interface ExtractionInfo {
  status: "ok" | "failed";
  /** Какими способами найдены метаданные и основной текст, например "jsonld+dom" или "readability". */
  method: string;
  warnings: string[];
  error?: { code: ExtractionErrorCode; message: string };
}

/**
 * Проверка выделенного фрагмента: утверждения берутся только из него, остальные блоки статьи — контекст
 * (заголовок, подзаголовок и соседние абзацы), чтобы модель раскрыла местоимения, даты и субъекты.
 */
export interface ArticleFocus {
  /** Блоки, которые пересекает выделение. */
  blockIds: string[];
  /** Выделенный текст, пробелы нормализованы. */
  text: string;
}

export interface ExtractedArticle {
  schemaVersion: typeof SCHEMA_VERSION;
  url: string;
  canonicalUrl: string | null;
  language: string | null;
  pageType: "article" | "unknown";
  metadata: ArticleMetadata;
  blocks: Block[];
  extraction: ExtractionInfo;
  /** Задано — проверяется только выделенный фрагмент, остальные блоки служат контекстом. */
  focus?: ArticleFocus | null;
}

// --- Утверждения и проверка ---

export const VERDICTS = ["supported", "contradicted", "qualified", "disputed", "insufficient"] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Технические состояния и мнения отделены от вердиктов.
 * `checked` означает, что вердикт получен; `opinion` не проверяется и не входит в знаменатель статистики.
 */
export const CLAIM_STATUSES = ["queued", "checking", "checked", "failed", "not_checked", "opinion"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export type ClaimKind = "event" | "date" | "number" | "quote" | "attribution" | "other";

export interface Evidence {
  url: string;
  title: string | null;
  /** ISO-время получения источника. */
  retrievedAt: string;
  role: "primary" | "secondary" | "unknown";
  /** Краткая связь источника с утверждением. */
  relation: string | null;
  /** Ссылка на исходную аннотацию grounding в ответе Gemini. Источники без неё не принимаются. */
  grounding: { interactionId: string | null; annotationIndex: number };
}

export interface ClaimOccurrence {
  blockId: string;
  /** Точный фрагмент текста этого блока (после нормализации пробелов). */
  exactText: string;
}

export interface Claim {
  id: string;
  blockIds: string[];
  /** Фрагмент первого вхождения; совпадает с `occurrences[0].exactText`. */
  exactText: string;
  /** Все вхождения утверждения: дубликаты из заголовка, подзаголовка и абзацев объединены в один claim. */
  occurrences: ClaimOccurrence[];
  normalizedClaim: string;
  kind: ClaimKind;
  status: ClaimStatus;
  verdict: Verdict | null;
  explanation: string | null;
  evidence: Evidence[];
  /** Описание технической ошибки для статуса `failed`. */
  error?: string | null;
  checkedAt?: string | null;
}

// --- API локального сервера ---

export type AnalysisStatus = "queued" | "extracting_claims" | "checking" | "completed" | "cancelled" | "failed";

export interface AnalysisStats {
  /** Уникальные проверяемые утверждения (без мнений). */
  total: number;
  /** Обработка завершена: получен вердикт (`checked`) или объяснённая ошибка (`failed`). */
  completed: number;
  /** Ещё в очереди, проверяется или не проверено из-за отмены. */
  notCompleted: number;
  byVerdict: Record<Verdict, number>;
  failed: number;
  notChecked: number;
  opinions: number;
}

/** Что сейчас делается с утверждением: составление запросов, поиск источников, вывод вердикта. */
export type CheckStep = "queries" | "search" | "verdict";

/** Живой ход анализа. Хранится только в памяти сервера и есть только у идущего анализа. */
export interface LiveProgress {
  /** Выделение утверждений: сколько частей статьи обработано из скольких. */
  extraction: { done: number; total: number } | null;
  /** Утверждения, которые проверяются прямо сейчас. */
  checking: { claimId: string; step: CheckStep; since: string; queries: string[] }[];
}

export interface AnalysisState {
  analysisId: string;
  status: AnalysisStatus;
  /** Проверка выделенного фрагмента; null — проверяется вся статья. */
  focus: ArticleFocus | null;
  /** true, пока не завершены все проверки: интерфейс показывает «предварительный результат». */
  preliminary: boolean;
  url: string;
  canonicalUrl: string | null;
  metadata: ArticleMetadata;
  claims: Claim[];
  stats: AnalysisStats;
  summary: string | null;
  error: string | null;
  /** null, если анализ не выполняется в этом процессе сервера (завершён или ждёт возобновления). */
  live: LiveProgress | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAnalysisResponse {
  analysisId: string;
  status: AnalysisStatus;
  /** true, если результат взят из кэша по URL и хэшу текста. */
  cached: boolean;
}

// --- Настройки сервера (страница настроек расширения) ---

export type LlmProvider = "gemini" | "ollama";
export type SearchProviderId = "searxng" | "ollama";

/** Что выбрано пользователем. Ключи API здесь не передаются: они только в .env сервера. */
export interface ServerSettings {
  provider: LlmProvider;
  model: string;
  /** Поиск источников для Ollama (у Gemini — встроенный Google Search). */
  searchProvider: SearchProviderId;
  /** Поисковики SearXNG; null — как включено в конфигурации SearXNG. */
  searxngEngines: string[] | null;
  queriesPerClaim: number;
}

export interface SettingsChoice<T extends string> {
  id: T;
  label: string;
  available: boolean;
  /** Почему вариант недоступен или что о нём нужно знать. */
  note: string | null;
}

export interface SettingsOptions {
  providers: SettingsChoice<LlmProvider>[];
  /** Доступные модели по провайдерам; пустой список — получить не удалось (см. note провайдера). */
  models: Record<LlmProvider, string[]>;
  searchProviders: SettingsChoice<SearchProviderId>[];
  /** Веб-поисковики SearXNG; пусто, если SearXNG недоступен. */
  searxngEngines: { name: string; enabledByDefault: boolean }[];
}

export interface SettingsResponse {
  settings: ServerSettings;
  options: SettingsOptions;
}

export interface HealthResponse {
  ok: boolean;
  /** Кто проверяет утверждения: Gemini с Google Search или локальная Ollama с поиском. */
  provider: LlmProvider;
  model: string;
  /** Чем ищутся источники, для показа пользователю: «Google Search», «SearXNG», «Ollama Web Search». */
  search: string;
  /** Почему проверка сейчас невозможна (нет ключа, Ollama не запущена, модель не скачана); null — всё готово. */
  problem: string | null;
}
