// Конфигурация сервера из переменных окружения. Значения ключей никогда не логируются и не отдаются в API.

import type { Provider } from "./llm/errors.ts";

export interface Config {
  host: "127.0.0.1";
  port: number;
  /** Кто выделяет и проверяет утверждения: Gemini с Google Search или локальная Ollama с Ollama Web Search. */
  provider: Provider;
  geminiApiKey: string | null;
  /** Активная модель выбранного провайдера. */
  model: string;
  /** Адрес локальной Ollama (не путать с OLLAMA_HOST самой Ollama, у которого другой формат). */
  ollamaUrl: string;
  ollamaApiKey: string | null;
  ollamaNumCtx: number;
  dbPath: string;
  /** Разрешённые Origin расширения (`chrome-extension://<id>`). */
  allowedOrigins: string[];
  checkConcurrency: number;
  maxBodyBytes: number;
  /** Символов текста статьи на один запрос извлечения утверждений. */
  chunkChars: number;
}

/**
 * Origin расширения из репозитория. ID стабилен, потому что в extension/static/manifest.json
 * задан публичный ключ (`key`); приватный ключ не хранится и для локальной установки не нужен.
 */
export const DEFAULT_EXTENSION_ORIGIN = "chrome-extension://gpmhmgppcnmhmkiiaefegfiboaoagiao";

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Некорректное число в конфигурации: ${value}`);
  return n;
}

function provider(value: string | undefined): Provider {
  const v = (value ?? "").trim().toLowerCase() || "gemini";
  if (v !== "gemini" && v !== "ollama") throw new Error(`LLM_PROVIDER должен быть gemini или ollama, а не «${value}»`);
  return v;
}

function localUrl(value: string | undefined, fallback: string): string {
  const url = new URL(value?.trim() || fallback);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Некорректный OLLAMA_URL: ${value}`);
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const p = provider(env.LLM_PROVIDER);
  return {
    host: "127.0.0.1",
    port: int(env.PORT, 8787, 1, 65535),
    provider: p,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    model: p === "ollama" ? env.OLLAMA_MODEL?.trim() || "qwen3:14b" : env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
    ollamaUrl: localUrl(env.OLLAMA_URL, "http://127.0.0.1:11434"),
    ollamaApiKey: env.OLLAMA_API_KEY?.trim() || null,
    ollamaNumCtx: int(env.OLLAMA_NUM_CTX, 16384, 2048, 262144),
    dbPath: env.DB_PATH?.trim() || "data/factcheck.sqlite",
    allowedOrigins: env.ALLOWED_ORIGINS?.trim()
      ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : [DEFAULT_EXTENSION_ORIGIN],
    checkConcurrency: int(env.CHECK_CONCURRENCY, p === "ollama" ? 1 : 2, 1, 8),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 2_000_000, 10_000, 20_000_000),
    chunkChars: int(env.CLAIM_CHUNK_CHARS, 8000, 1000, 100_000),
  };
}
