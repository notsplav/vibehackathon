// Классификация ошибок модели и поиска для повторов и понятных состояний claim.

export type Provider = "gemini" | "ollama";

export type ModelErrorKind =
  | "quota_exhausted"
  | "rate_limited"
  | "unavailable"
  | "auth"
  | "not_configured"
  | "bad_request"
  | "timeout"
  | "invalid_response"
  | "unknown";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(kind: ModelErrorKind, message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "timeout";
  }

  /** Ошибка, после которой нет смысла запускать остальные проверки этого анализа. */
  get fatal(): boolean {
    return this.kind === "quota_exhausted" || this.kind === "auth" || this.kind === "not_configured";
  }
}

/** Сообщение для пользователя: без ключа, тела запроса и внутренних деталей. */
export function userMessage(kind: ModelErrorKind, provider: Provider): string {
  const gemini = provider === "gemini";
  switch (kind) {
    case "quota_exhausted":
      return gemini
        ? "Квота Gemini API исчерпана (429). Проверьте лимиты и биллинг проекта на ai.dev/rate-limit."
        : "Лимит Ollama Web Search исчерпан (429). Проверьте аккаунт на ollama.com.";
    case "rate_limited":
      return gemini ? "Слишком много запросов к Gemini (429), повторы не помогли." : "Слишком много запросов к Ollama Web Search (429), повторы не помогли.";
    case "unavailable":
      return gemini ? "Gemini временно недоступен (5xx), повторы не помогли." : "Ollama недоступна: запустите её (ollama serve) и повторите анализ.";
    case "auth":
      return gemini
        ? "Ключ Gemini недействителен или не имеет доступа к модели."
        : "OLLAMA_API_KEY недействителен или не задан: веб-поиск Ollama недоступен.";
    case "not_configured":
      return gemini ? "Сервер не настроен: GEMINI_API_KEY не задан." : "Модель не найдена в Ollama: скачайте её командой ollama pull.";
    case "bad_request":
      return "Модель отклонила запрос (400).";
    case "timeout":
      return "Модель не ответила вовремя.";
    case "invalid_response":
      return "Модель вернула ответ в неожиданном формате.";
    default:
      return "Ошибка при обращении к модели.";
  }
}

export function classifyError(e: unknown, secret: string | null): ModelError {
  if (e instanceof ModelError) return e;
  const err = e as { status?: unknown; message?: unknown; name?: unknown; cause?: { code?: unknown }; headers?: { get?: (k: string) => string | null } };
  const status = typeof err?.status === "number" ? err.status : null;
  let message = String(err?.message ?? e);
  if (secret) message = message.replaceAll(secret, "***");
  message = message.slice(0, 500);
  const retryAfter = Number(err?.headers?.get?.("retry-after"));
  // Google присылает задержку в RetryInfo: "retryDelay": "37s" или «Please retry in 37.2s».
  const hinted = /retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s|retry in (\d+(?:\.\d+)?)\s*s/i.exec(message);
  const hintSeconds = hinted ? Number(hinted[1] ?? hinted[2]) : NaN;
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(hintSeconds) ? Math.ceil(hintSeconds * 1000) : null;

  if (err?.name === "AbortError" || err?.name === "TimeoutError" || /timed? ?out|ETIMEDOUT/i.test(message)) return new ModelError("timeout", message, status);
  // fetch не смог соединиться (например, Ollama не запущена).
  if (status === null && (err?.cause?.code === "ECONNREFUSED" || /fetch failed|ECONNREFUSED/i.test(message))) {
    return new ModelError("unavailable", message);
  }
  // Текст 429 одинаков для минутного лимита и исчерпанной квоты, поэтому здесь это всегда rate_limited;
  // исчерпание квоты определяет конвейер, если 429 повторяется после всех повторов.
  if (status === 429) return new ModelError("rate_limited", message, status, retryAfterMs);
  if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED|API_KEY_INVALID/i.test(message)) {
    return new ModelError("auth", message, status);
  }
  if (status !== null && status >= 500) return new ModelError("unavailable", message, status, retryAfterMs);
  if (status === 400) return new ModelError("bad_request", message, status);
  return new ModelError("unknown", message, status);
}
