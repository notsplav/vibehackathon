// Классификация ошибок Gemini для повторов и понятных состояний claim.

export type GeminiErrorKind = "quota_exhausted" | "rate_limited" | "unavailable" | "auth" | "bad_request" | "timeout" | "invalid_response" | "unknown";

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(kind: GeminiErrorKind, message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "timeout";
  }

  /** Ошибка, после которой нет смысла запускать остальные проверки этого анализа. */
  get fatal(): boolean {
    return this.kind === "quota_exhausted" || this.kind === "auth";
  }
}

/** Сообщение для пользователя: без ключа, тела запроса и внутренних деталей. */
export function userMessage(kind: GeminiErrorKind): string {
  switch (kind) {
    case "quota_exhausted":
      return "Квота Gemini API исчерпана (429). Проверьте лимиты и биллинг проекта на ai.dev/rate-limit.";
    case "rate_limited":
      return "Слишком много запросов к Gemini (429), повторы не помогли.";
    case "unavailable":
      return "Gemini временно недоступен (5xx), повторы не помогли.";
    case "auth":
      return "Ключ Gemini недействителен или не имеет доступа к модели.";
    case "bad_request":
      return "Gemini отклонил запрос (400).";
    case "timeout":
      return "Gemini не ответил вовремя.";
    case "invalid_response":
      return "Gemini вернул ответ в неожиданном формате.";
    default:
      return "Ошибка при обращении к Gemini.";
  }
}

export function classifyError(e: unknown, apiKey: string | null): GeminiError {
  if (e instanceof GeminiError) return e;
  const err = e as { status?: unknown; message?: unknown; name?: unknown; headers?: { get?: (k: string) => string | null } };
  const status = typeof err?.status === "number" ? err.status : null;
  let message = String(err?.message ?? e);
  if (apiKey) message = message.replaceAll(apiKey, "***");
  message = message.slice(0, 500);
  const retryAfter = Number(err?.headers?.get?.("retry-after"));
  // Google присылает задержку в RetryInfo: "retryDelay": "37s" или «Please retry in 37.2s».
  const hinted = /retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s|retry in (\d+(?:\.\d+)?)\s*s/i.exec(message);
  const hintSeconds = hinted ? Number(hinted[1] ?? hinted[2]) : NaN;
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(hintSeconds) ? Math.ceil(hintSeconds * 1000) : null;

  if (err?.name === "AbortError" || /timed? ?out|ETIMEDOUT/i.test(message)) return new GeminiError("timeout", message, status);
  // Текст 429 одинаков для минутного лимита и исчерпанной квоты, поэтому здесь это всегда rate_limited;
  // исчерпание квоты определяет конвейер, если 429 повторяется после всех повторов.
  if (status === 429) return new GeminiError("rate_limited", message, status, retryAfterMs);
  if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED|API_KEY_INVALID/i.test(message)) {
    return new GeminiError("auth", message, status);
  }
  if (status !== null && status >= 500) return new GeminiError("unavailable", message, status, retryAfterMs);
  if (status === 400) return new GeminiError("bad_request", message, status);
  return new GeminiError("unknown", message, status);
}
