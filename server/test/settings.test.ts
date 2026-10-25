import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { createApp } from "../src/http.ts";
import { AnalysisRunner } from "../src/pipeline/runner.ts";
import { SettingsService } from "../src/settings.ts";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/**
 * ТЕСТОВАЯ ПОДМЕНА fetch: локальная Ollama (/api/tags) и SearXNG (/search, /config).
 * В работе сервер опрашивает настоящие сервисы.
 */
const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.port === "11434" && url.pathname === "/api/tags") return json({ models: [{ name: "qwen3:14b" }, { name: "qwen3:8b" }] });
  if (url.port === "8888" && url.pathname === "/search") return json({ error: "No query" }, 400);
  if (url.port === "8888" && url.pathname === "/config") {
    return json({
      engines: [
        { name: "bing", enabled: true, categories: ["general", "web"] },
        { name: "yep", enabled: false, categories: ["general"] },
        { name: "currency", enabled: true, categories: ["currency", "general"] },
        { name: "wikipedia", enabled: true, categories: ["general"] },
      ],
    });
  }
  return json({}, 404);
}) as typeof fetch;

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

async function setup() {
  const config = { ...loadConfig({ ALLOWED_ORIGINS: ORIGIN, LLM_PROVIDER: "ollama" }), dbPath: ":memory:", geminiApiKey: null };
  const store = new Store(":memory:");
  const settings = new SettingsService(store, config, () => {}, fakeFetch);
  const runner = new AnalysisRunner(store, () => ({ provider: "ollama", checker: null, secret: null, concurrency: 1 }), { chunkChars: 8000, reuseHours: 24 }, { info() {}, warn() {} });
  const server = createApp({ config, store, runner, settings });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => server.close(), () => store.close());
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown, origin: string | null = ORIGIN) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
      if (origin) headers.Origin = origin;
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload) headers["Content-Type"] = "application/json";
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  return { call, store, settings };
}

test("настройки: значения из .env и варианты — модели Ollama, поисковики SearXNG без переводчиков", async () => {
  const { call } = await setup();
  const { status, body } = await call("GET", "/api/settings");
  expect(status).toBe(200);
  expect(body.settings).toEqual({ provider: "ollama", model: "qwen3:14b", searchProvider: "searxng", searxngEngines: null, queriesPerClaim: 2 });
  expect(body.options.models).toEqual({ ollama: ["qwen3:14b", "qwen3:8b"], gemini: [] });
  expect(body.options.providers.map((p: any) => [p.id, p.available])).toEqual([["ollama", true], ["gemini", false]]);
  expect(body.options.searxngEngines).toEqual([
    { name: "bing", enabledByDefault: true },
    { name: "wikipedia", enabledByDefault: true },
    { name: "yep", enabledByDefault: false },
  ]);
});

test("сохранение: только с Origin расширения, проверка выбора, применяется без перезапуска", async () => {
  const { call, store } = await setup();
  const next = { provider: "ollama", model: "qwen3:8b", searchProvider: "searxng", searxngEngines: ["bing", "yep"], queriesPerClaim: 1 };
  expect((await call("PUT", "/api/settings", next, null)).status).toBe(403);
  expect((await call("PUT", "/api/settings", { ...next, model: "llama3:70b" })).status).toBe(422);
  expect((await call("PUT", "/api/settings", { ...next, searxngEngines: ["mojeek"] })).status).toBe(422);
  expect((await call("PUT", "/api/settings", { ...next, provider: "gemini", model: "gemini-3.8-flash" })).status).toBe(422);
  expect((await call("PUT", "/api/settings", { ...next, queriesPerClaim: 9 })).status).toBe(400);

  const saved = await call("PUT", "/api/settings", next);
  expect(saved.status).toBe(200);
  expect(saved.body.settings).toEqual(next);
  expect(store.getSetting("server")).toEqual(next);
  expect((await call("GET", "/api/health")).body).toMatchObject({ provider: "ollama", model: "qwen3:8b", search: "SearXNG" });
});

test("поисковики из настроек передаются в запрос SearXNG", async () => {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ results: [{ url: "https://a.example/", title: "A", content: "a" }] }), { status: 200 });
  }) as typeof fetch;
  const { SearxngSearch } = await import("../src/search/searxng.ts");
  await new SearxngSearch({ baseUrl: "http://127.0.0.1:8888", retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, perQuery: 5, engines: ["bing", "yep"], fetch: f }).search("тест");
  expect(new URL(urls[0]!).searchParams.get("engines")).toBe("bing,yep");
});
