// HTTP API локального сервера (ТЗ 8). Слушает только 127.0.0.1.
// CORS-заголовков нет: расширение обращается к серверу через host_permissions, а обычные сайты
// не могут прочитать ответы. Изменяющие запросы принимаются только с Origin расширения.

import { createHash, randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { Block, CreateAnalysisResponse, HealthResponse } from "../../shared/contract.ts";
import { normalizeSpace } from "../../shared/text.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db/store.ts";
import { ALGORITHM_VERSION, type AnalysisRunner } from "./pipeline/runner.ts";
import { extractedArticleSchema } from "./schema.ts";

export interface AppDeps {
  config: Config;
  store: Store;
  runner: AnalysisRunner;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ID = /^[0-9a-f-]{36}$/;

/** Хэш нормализованного текста блоков: ключ кэша вместе с URL, чтобы не показывать результат старой редакции. */
export function textHash(blocks: Pick<Block, "type" | "text">[]): string {
  const h = createHash("sha256");
  for (const b of blocks) h.update(`${b.type}\n${normalizeSpace(b.text)}\n\n`);
  return h.digest("hex");
}

function cacheUrl(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return reject(new HttpError(413, "Слишком большой запрос"));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Слишком большой запрос"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Защита локального сервера от запросов со сторонних сайтов и от DNS rebinding. */
function guard(req: IncomingMessage, config: Config): void {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!ALLOWED_HOSTS.has(host)) throw new HttpError(403, "Недопустимый Host");

  const origin = req.headers.origin;
  const originAllowed = typeof origin === "string" && config.allowedOrigins.includes(origin);
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  // GET без Origin (curl, адресная строка) допустим; с чужим Origin — нет.
  if (origin !== undefined && !originAllowed) throw new HttpError(403, "Недопустимый Origin");
  if (mutating && !originAllowed) throw new HttpError(403, "Требуется Origin расширения");
}

export function createApp({ config, store, runner }: AppDeps): Server {
  const routes = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    guard(req, config);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") throw new HttpError(404, "Не найдено");

    if (parts[1] === "health" && parts.length === 2 && req.method === "GET") {
      const body: HealthResponse = { ok: true, geminiConfigured: !!config.geminiApiKey, model: config.model };
      return send(res, 200, body);
    }

    if (parts[1] !== "analyses") throw new HttpError(404, "Не найдено");

    if (parts.length === 2 && req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Ожидается application/json");
      let json: unknown;
      try {
        json = JSON.parse(await readBody(req, config.maxBodyBytes));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "Некорректный JSON");
      }
      const parsed = extractedArticleSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new HttpError(400, `Неверный формат статьи: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim());
      }
      const article = parsed.data;
      if (article.extraction.status !== "ok" || article.blocks.length === 0) {
        throw new HttpError(422, "Статья не извлечена: анализ невозможен");
      }
      const ids = new Set(article.blocks.map((b) => b.id));
      if (ids.size !== article.blocks.length) throw new HttpError(400, "Повторяющиеся blockId");

      const hash = textHash(article.blocks);
      const key = cacheUrl(article.canonicalUrl ?? article.url);
      const force = url.searchParams.get("force") === "1";
      const cached = force ? null : store.findCached(key, hash, ALGORITHM_VERSION);
      if (cached) {
        // Прерванный перезапуском анализ продолжится.
        if (!["completed", "cancelled", "failed"].includes(cached.status)) runner.start(cached.id);
        const body: CreateAnalysisResponse = { analysisId: cached.id, status: cached.status, cached: true };
        return send(res, 200, body);
      }
      const id = randomUUID();
      store.createAnalysis({
        id,
        url: article.url,
        canonicalUrl: article.canonicalUrl,
        cacheUrl: key,
        textHash: hash,
        algorithmVersion: ALGORITHM_VERSION,
        metadata: article.metadata,
        blocks: article.blocks,
      });
      runner.start(id);
      const body: CreateAnalysisResponse = { analysisId: id, status: "queued", cached: false };
      return send(res, 201, body);
    }

    const id = parts[2];
    if (!id || !ID.test(id)) throw new HttpError(404, "Не найдено");

    if (parts.length === 3 && req.method === "GET") {
      const state = store.getState(id);
      if (!state) throw new HttpError(404, "Анализ не найден");
      return send(res, 200, state);
    }
    if (parts.length === 4 && parts[3] === "cancel" && req.method === "POST") {
      if (!runner.cancel(id)) throw new HttpError(404, "Анализ не найден");
      return send(res, 200, store.getState(id));
    }
    if (parts.length === 3 && req.method === "DELETE") {
      runner.abort(id);
      if (!store.deleteAnalysis(id)) throw new HttpError(404, "Анализ не найден");
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    throw new HttpError(405, "Метод не поддерживается");
  };

  return createServer((req, res) => {
    routes(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error("internal error:", e instanceof Error ? e.message : String(e));
      send(res, 500, { error: "Внутренняя ошибка сервера" });
    });
  });
}
