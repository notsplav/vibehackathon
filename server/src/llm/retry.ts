// Повторы с экспоненциальной задержкой для 429/5xx/таймаутов.

import { ModelError, classifyError } from "./errors.ts";

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 2000, maxDelayMs: 60_000 };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

/** Учитывает подсказку задержки от сервиса (Retry-After, retryDelay). `secret` вырезается из сообщений об ошибках. */
export async function withRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, secret: string | null, signal?: AbortSignal): Promise<T> {
  let last: ModelError | null = null;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted) throw e;
      last = classifyError(e, secret);
      if (!last.retryable || attempt === policy.attempts) throw last;
      const backoff = policy.baseDelayMs * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
      await sleep(Math.min(policy.maxDelayMs, Math.max(backoff, last.retryAfterMs ?? 0)), signal);
    }
  }
  throw last ?? new ModelError("unknown", "retry loop exhausted");
}

/** Разбирает JSON из ответа модели; иногда он приходит в ```-блоке. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* ниже */
      }
    }
    throw new ModelError("invalid_response", "Ответ модели не является JSON");
  }
}
