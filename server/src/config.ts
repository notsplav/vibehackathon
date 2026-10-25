// Конфигурация сервера из переменных окружения. Значение ключа никогда не логируется и не отдаётся в API.

export interface Config {
  host: "127.0.0.1";
  port: number;
  geminiApiKey: string | null;
  model: string;
  dbPath: string;
  /** Разрешённые Origin расширения (`chrome-extension://<id>`). Пусто — любой chrome-extension://. */
  allowedOrigins: string[];
  checkConcurrency: number;
  maxBodyBytes: number;
  /** Символов текста статьи на один запрос извлечения утверждений. */
  chunkChars: number;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Некорректное число в конфигурации: ${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: "127.0.0.1",
    port: int(env.PORT, 8787, 1, 65535),
    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    model: env.GEMINI_MODEL?.trim() || "gemini-3.8-flash",
    dbPath: env.DB_PATH?.trim() || "data/factcheck.sqlite",
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    checkConcurrency: int(env.CHECK_CONCURRENCY, 2, 1, 8),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 2_000_000, 10_000, 20_000_000),
    chunkChars: int(env.CLAIM_CHUNK_CHARS, 8000, 1000, 100_000),
  };
}
