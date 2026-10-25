import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import type { AnalysisState, ExtractedArticle } from "../../shared/contract.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { ModelError } from "../src/llm/errors.ts";
import type { CheckInput, CheckOutcome, FactChecker, StepCallback } from "../src/llm/types.ts";
import { createApp } from "../src/http.ts";
import type { RawClaim } from "../src/pipeline/claims.ts";
import { AnalysisRunner } from "../src/pipeline/runner.ts";
import type { SettingsPort } from "../src/settings.ts";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const article: ExtractedArticle = {
  schemaVersion: 1,
  url: "https://news.example.test/a/1#top",
  canonicalUrl: "https://news.example.test/a/1",
  language: "ru",
  pageType: "article",
  metadata: { title: "Заголовок", subtitle: null, authors: [], publishedAt: null, modifiedAt: null },
  blocks: [
    { id: "b1", type: "title", order: 1, text: "В Заречье открылась библиотека", links: [] },
    { id: "b2", type: "paragraph", order: 2, text: "В Заречье открылась библиотека. Фонд насчитывает 40 тысяч книг.", links: [] },
    { id: "b3", type: "paragraph", order: 3, text: "Это лучшая библиотека города. Она работает с 10:00 до 20:00.", links: [] },
  ],
  extraction: { status: "ok", method: "jsonld+dom", warnings: [] },
};

/**
 * ТЕСТОВАЯ ЗАГЛУШКА модели: детерминированные ответы для проверки конвейера.
 * В работе сервер использует только GeminiFactChecker или OllamaFactChecker и никогда не подставляет демонстрационные данные.
 */
class FakeChecker implements FactChecker {
  checkCalls = 0;
  gate: Promise<void> | null = null;
  failWith: ModelError | null = null;

  async extractClaims(): Promise<RawClaim[]> {
    return [
      { occurrences: [{ blockId: "b1", exactText: "В Заречье открылась библиотека" }], normalizedClaim: "В Заречье открылась библиотека", kind: "event", isOpinion: false },
      { occurrences: [{ blockId: "b2", exactText: "В Заречье открылась библиотека" }], normalizedClaim: "В Заречье открылась библиотека", kind: "event", isOpinion: false },
      { occurrences: [{ blockId: "b2", exactText: "Фонд насчитывает 40 тысяч книг" }], normalizedClaim: "Фонд библиотеки — 40 тысяч книг", kind: "number", isOpinion: false, searchQueries: ["фонд библиотеки Заречье 40 тысяч книг"] },
      { occurrences: [{ blockId: "b3", exactText: "Это лучшая библиотека города" }], normalizedClaim: "Это лучшая библиотека города", kind: "other", isOpinion: true },
      { occurrences: [{ blockId: "b3", exactText: "Она работает с 10:00 до 20:00" }], normalizedClaim: "Библиотека работает с 10:00 до 20:00", kind: "other", isOpinion: false },
    ];
  }

  queriesSeen = new Map<string, string[]>();

  async checkClaim(input: CheckInput, _signal?: AbortSignal, onStep?: StepCallback): Promise<CheckOutcome> {
    this.checkCalls++;
    this.queriesSeen.set(input.claim, input.searchQueries ?? []);
    onStep?.("search", [`запрос: ${input.claim}`]);
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    const cited = input.claim.includes("40 тысяч");
    return {
      verdict: "supported",
      explanation: "Тест",
      sources: cited ? [{ index: 1, role: "secondary", relation: "Сообщение администрации" }] : [],
      citations: cited ? [{ url: "https://city.example.org/news/1", title: "city.example.org", annotationIndex: 0, citedText: null }] : [],
      interactionId: "test",
      searchQueries: [],
    };
  }

  async summarize(): Promise<string> {
    return "Тестовая сводка.";
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

async function setup(checker: FactChecker | null = new FakeChecker()) {
  const config = { ...loadConfig({ ALLOWED_ORIGINS: ORIGIN }), dbPath: ":memory:", geminiApiKey: checker ? "test" : null };
  const store = new Store(":memory:");
  const runner = new AnalysisRunner(store, () => ({ provider: "gemini", checker, secret: null, concurrency: 2 }), { chunkChars: 8000, reuseHours: 24 }, { info() {}, warn() {} });
  // Настройки здесь не проверяются (см. settings.test.ts): фиксированная конфигурация Gemini.
  const settings: SettingsPort = {
    current: () => ({ provider: "gemini", model: "gemini-3.8-flash", searchName: "Google Search", engine: "gemini:gemini-3.8-flash", problem: async () => (checker ? null : "GEMINI_API_KEY не задан") }),
    describe: async () => {
      throw new Error("не используется");
    },
    update: async () => ({ ok: false, error: "не используется" }),
  };
  const server = createApp({ config, store, runner, settings });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => server.close(), () => store.close());
  const port = (server.address() as AddressInfo).port;

  const call = (method: string, path: string, opts: { origin?: string | null; host?: string; body?: unknown; contentType?: string } = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}` };
      if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
      const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      if (payload !== undefined) headers["Content-Type"] = opts.contentType ?? "application/json";
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      });
      req.on("error", reject);
      req.end(payload);
    });

  const waitFor = async (id: string, done: (s: AnalysisState) => boolean): Promise<AnalysisState> => {
    for (let i = 0; i < 200; i++) {
      const { body } = await call("GET", `/api/analyses/${id}`);
      if (done(body)) return body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  return { call, waitFor, store, runner };
}

describe("защита локального API", () => {
  test("чужой Origin, отсутствие Origin у POST, чужой Host и не-JSON отклоняются", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/health", { origin: null })).status).toBe(200);
    expect((await call("GET", "/api/health", { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/analyses", { origin: null, body: article })).status).toBe(403);
    expect((await call("POST", "/api/analyses", { origin: "chrome-extension://other", body: article })).status).toBe(403);
    expect((await call("GET", "/api/health", { host: "evil.example:8787" })).status).toBe(403);
    expect((await call("POST", "/api/analyses", { body: article, contentType: "text/plain" })).status).toBe(415);
    expect((await call("POST", "/api/analyses", { body: { ...article, url: "file:///etc/passwd" } })).status).toBe(400);
  });

  test("health не раскрывает ключ", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/api/health");
    expect(body).toEqual({ ok: true, provider: "gemini", model: "gemini-3.8-flash", search: "Google Search", problem: null });
  });
});

test("полный проход: дубликаты объединены, мнение вне статистики, supported без ссылки понижен", async () => {
  const { call, waitFor } = await setup();
  const created = await call("POST", "/api/analyses", { body: article });
  expect(created.status).toBe(201);
  const state = await waitFor(created.body.analysisId, (s) => s.status === "completed" && s.summary !== null && s.live === null);

  expect(state.claims.map((c) => [c.normalizedClaim, c.blockIds, c.status, c.verdict])).toEqual([
    ["В Заречье открылась библиотека", ["b1", "b2"], "checked", "insufficient"],
    ["Фонд библиотеки — 40 тысяч книг", ["b2"], "checked", "supported"],
    ["Это лучшая библиотека города", ["b3"], "opinion", null],
    ["Библиотека работает с 10:00 до 20:00", ["b3"], "checked", "insufficient"],
  ]);
  expect(state.claims[1]!.evidence[0]!.url).toBe("https://city.example.org/news/1");
  expect(state.stats).toEqual({
    total: 3,
    completed: 3,
    notCompleted: 0,
    byVerdict: { supported: 1, contradicted: 0, qualified: 0, disputed: 0, insufficient: 2 },
    failed: 0,
    notChecked: 0,
    opinions: 1,
  });
  expect(state.preliminary).toBe(false);
  expect(state.live).toBeNull();

  // Та же редакция статьи берётся из кэша, force=1 запускает новый анализ.
  const again = await call("POST", "/api/analyses", { body: article });
  expect(again.body).toEqual({ analysisId: created.body.analysisId, status: "completed", cached: true });
  const forced = await call("POST", "/api/analyses?force=1", { body: article });
  expect(forced.body.analysisId).not.toBe(created.body.analysisId);
  // Изменённый текст — другая редакция, кэш не используется.
  const edited = { ...article, blocks: [...article.blocks.slice(0, 2), { ...article.blocks[2]!, text: "Новый текст абзаца." }] };
  expect((await call("POST", "/api/analyses", { body: edited })).body.cached).toBe(false);
});

test("запросы, составленные при извлечении, сохраняются и доходят до проверки", async () => {
  const checker = new FakeChecker();
  const { call, waitFor } = await setup(checker);
  const { body } = await call("POST", "/api/analyses", { body: article });
  await waitFor(body.analysisId, (s) => s.status === "completed" && s.live === null);
  expect(checker.queriesSeen.get("Фонд библиотеки — 40 тысяч книг")).toEqual(["фонд библиотеки Заречье 40 тысяч книг"]);
  expect(checker.queriesSeen.get("Библиотека работает с 10:00 до 20:00")).toEqual([]);
});

test("отмена: готовые результаты сохраняются, остальные — not_checked", async () => {
  const checker = new FakeChecker();
  let release!: () => void;
  checker.gate = new Promise((r) => (release = r));
  const { call, waitFor } = await setup(checker);
  const { body } = await call("POST", "/api/analyses", { body: article });
  await waitFor(body.analysisId, (s) => s.claims.filter((c) => c.status === "checking").length === 2);

  // Живой прогресс: какие утверждения проверяются и на каком шаге.
  const during = await call("GET", `/api/analyses/${body.analysisId}`);
  expect(during.body.live.extraction).toEqual({ done: 1, total: 1 });
  expect(during.body.live.checking.map((c: any) => [c.claimId, c.step, c.queries.length])).toEqual([
    ["c1", "search", 1],
    ["c2", "search", 1],
  ]);

  const cancelled = await call("POST", `/api/analyses/${body.analysisId}/cancel`);
  expect(cancelled.body.status).toBe("cancelled");
  release();
  const state = await waitFor(body.analysisId, (s) => !s.claims.some((c) => c.status === "checking"));
  expect(state.claims.map((c) => c.status)).toEqual(["checked", "checked", "opinion", "not_checked"]);
  expect(state.stats.notChecked).toBe(1);
  expect(checker.checkCalls).toBe(2);
});

test("повторяющийся 429 останавливает проверки с понятной причиной", async () => {
  const checker = new FakeChecker();
  checker.failWith = new ModelError("rate_limited", "429", 429);
  const { call, waitFor } = await setup(checker);
  const { body } = await call("POST", "/api/analyses", { body: article });
  const state = await waitFor(body.analysisId, (s) => s.status === "completed");
  expect(state.claims.filter((c) => c.status === "failed")).toHaveLength(3);
  expect(state.error).toMatch(/Квота Gemini API исчерпана/);
  expect(checker.checkCalls).toBeLessThanOrEqual(3);
});

test("без ключа анализ завершается объяснённой ошибкой", async () => {
  const { call, waitFor } = await setup(null);
  const { body } = await call("POST", "/api/analyses", { body: article });
  const state = await waitFor(body.analysisId, (s) => s.status === "failed");
  expect(state.error).toMatch(/GEMINI_API_KEY/);
});

test("после перезапуска прерванные проверки продолжаются", async () => {
  const { call, waitFor, store, runner } = await setup();
  const { body } = await call("POST", "/api/analyses", { body: article });
  await waitFor(body.analysisId, (s) => s.status === "completed");
  // Имитируем остановку сервера посреди проверки.
  store.setStatus(body.analysisId, "checking");
  store.moveClaims(body.analysisId, ["checked"], "checking");
  runner.resumeAll();
  const state = await waitFor(body.analysisId, (s) => s.status === "completed");
  expect(state.claims.filter((c) => c.status === "checked")).toHaveLength(3);
});

test("одинаковые утверждения проверяются один раз: другой анализ берёт готовый результат, «Повторить» — нет", async () => {
  const checker = new FakeChecker();
  const { call, waitFor } = await setup(checker);
  const first = await call("POST", "/api/analyses", { body: article });
  await waitFor(first.body.analysisId, (s) => s.status === "completed" && s.live === null);
  expect(checker.checkCalls).toBe(3);

  // Та же новость на другом сайте: те же утверждения.
  const reprint = { ...article, url: "https://other.example.test/news/7", canonicalUrl: "https://other.example.test/news/7" };
  const second = await call("POST", "/api/analyses", { body: reprint });
  const state = await waitFor(second.body.analysisId, (s) => s.status === "completed" && s.live === null);
  expect(checker.checkCalls).toBe(3);
  expect(state.claims.filter((c) => c.status === "checked").map((c) => c.verdict)).toEqual(["insufficient", "supported", "insufficient"]);
  expect(state.claims[1]!.evidence[0]!.url).toBe("https://city.example.org/news/1");
  expect(state.claims[0]!.explanation).toMatch(/Результат взят из проверки того же утверждения/);

  const forced = await call("POST", "/api/analyses?force=1", { body: reprint });
  await waitFor(forced.body.analysisId, (s) => s.status === "completed" && s.live === null);
  expect(checker.checkCalls).toBe(6);
});

test("DELETE удаляет результат", async () => {
  const { call, waitFor } = await setup();
  const { body } = await call("POST", "/api/analyses", { body: article });
  await waitFor(body.analysisId, (s) => s.status === "completed");
  expect((await call("DELETE", `/api/analyses/${body.analysisId}`)).status).toBe(204);
  expect((await call("GET", `/api/analyses/${body.analysisId}`)).status).toBe(404);
});
