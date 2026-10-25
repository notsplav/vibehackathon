// Конфигурация сервера из переменных окружения. Значения ключей никогда не логируются и не отдаются в API.

import type { Provider } from "./llm/errors.ts";

export interface Config {
  host: "127.0.0.1";
  port: number;
  /** Кто выделяет и проверяет утверждения: Gemini с Google Search или локальная Ollama с Ollama Web Search. */
  provider: Provider;
  geminiApiKey: string | null;
  /** Модель провайдера из .env (значение по умолчанию; на странице настроек можно выбрать другую). */
  model: string;
  geminiModel: string;
  ollamaModel: string;
  /** Адрес локальной Ollama (не путать с OLLAMA_HOST самой Ollama, у которого другой формат). */
  ollamaUrl: string;
  ollamaApiKey: string | null;
  ollamaNumCtx: number;
  /** Поиск источников для провайдера Ollama: локальный SearXNG или Ollama Web Search. */
  searchProvider: "searxng" | "ollama";
  searxngUrl: string;
  /** Поисковых запросов на одно утверждение (провайдер Ollama). */
  searchQueriesPerClaim: number;
  /** Сколько часов результат проверки утверждения можно переиспользовать для такого же утверждения; 0 — не переиспользовать. */
  claimReuseHours: number;
  dbPath: string;
  /** Разрешённые Origin расширения (`chrome-extension://<id>`). */
  allowedOrigins: string[];
  /** CHECK_CONCURRENCY из .env; null — по умолчанию для провайдера (2 для Gemini, 1 для Ollama). */
  checkConcurrency: number | null;
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

function localUrl(name: string, value: string | undefined, fallback: string): string {
  const url = new URL(value?.trim() || fallback);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Некорректный ${name}: ${value}`);
  return url.origin;
}

function searchProvider(value: string | undefined): "searxng" | "ollama" {
  const v = (value ?? "").trim().toLowerCase() || "searxng";
  if (v !== "searxng" && v !== "ollama") throw new Error(`SEARCH_PROVIDER должен быть searxng или ollama, а не «${value}»`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const p = provider(env.LLM_PROVIDER);
  return {
    host: "127.0.0.1",
    port: int(env.PORT, 8787, 1, 65535),
    provider: p,
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    model: p === "ollama" ? env.OLLAMA_MODEL?.trim() || "qwen3:14b" : env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
    geminiModel: env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
    ollamaModel: env.OLLAMA_MODEL?.trim() || "qwen3:14b",
    ollamaUrl: localUrl("OLLAMA_URL", env.OLLAMA_URL, "http://127.0.0.1:11434"),
    ollamaApiKey: env.OLLAMA_API_KEY?.trim() || null,
    ollamaNumCtx: int(env.OLLAMA_NUM_CTX, 16384, 2048, 262144),
    searchProvider: searchProvider(env.SEARCH_PROVIDER),
    searxngUrl: localUrl("SEARXNG_URL", env.SEARXNG_URL, "http://127.0.0.1:8888"),
    searchQueriesPerClaim: int(env.SEARCH_QUERIES_PER_CLAIM, 2, 1, 5),
    claimReuseHours: int(env.CLAIM_REUSE_HOURS, 24, 0, 24 * 30),
    dbPath: env.DB_PATH?.trim() || "data/factcheck.sqlite",
    allowedOrigins: env.ALLOWED_ORIGINS?.trim()
      ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : [DEFAULT_EXTENSION_ORIGIN],
    checkConcurrency: env.CHECK_CONCURRENCY?.trim() ? int(env.CHECK_CONCURRENCY, 2, 1, 8) : null,
    maxBodyBytes: int(env.MAX_BODY_BYTES, 2_000_000, 10_000, 20_000_000),
    chunkChars: int(env.CLAIM_CHUNK_CHARS, 8000, 1000, 100_000),
  };
}
