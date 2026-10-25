import { describe, expect, test } from "vitest";
import { OllamaFactChecker, ollamaProblem } from "../src/ollama/client.ts";
import { decideVerdict } from "../src/pipeline/evidence.ts";
import { OllamaWebSearch, WEB_SEARCH_URL } from "../src/search/ollama.ts";
import { SearxngSearch } from "../src/search/searxng.ts";
import type { SearchProvider } from "../src/search/types.ts";

const KEY = "test-ollama-key";
const fast = { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 };
const OLLAMA = "http://127.0.0.1:11434";
const SEARXNG = "http://127.0.0.1:8888";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * ТЕСТОВАЯ ПОДМЕНА fetch: отвечает как Ollama (/api/chat), SearXNG и Ollama Web Search по сценарию.
 * В работе сервер обращается к настоящим сервисам и не подставляет такие данные.
 */
function fakeFetch(handler: (call: Call) => { status?: number; json?: unknown; throws?: Error }) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const { status = 200, json = {}, throws } = handler(call);
    if (throws) throw throws;
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

const chatReply = (content: unknown) => ({ json: { message: { role: "assistant", content: JSON.stringify(content) }, done: true } });
const isChat = (c: Call) => c.url.startsWith(OLLAMA);
const system = (c: Call) => c.body.messages[0].content as string;

function checker(f: typeof fetch, search: SearchProvider, queriesPerClaim = 2) {
  return new OllamaFactChecker({ host: OLLAMA, model: "qwen3:14b", numCtx: 16384, search, queriesPerClaim, retry: fast, fetch: f });
}

const input = {
  claim: "Мария Кюри родилась 7 ноября 1867 года в Варшаве",
  kind: "date" as const,
  context: ["Мария Склодовская-Кюри родилась 7 ноября 1867 года в Варшаве."],
  article: { title: "Мария Кюри", publishedAt: null, url: "https://news.example.test/curie" },
};

const RESULTS = [
  { title: "Мария Кюри — биография", url: "https://www.nobelprize.org/curie", content: "Родилась 7 ноября 1867 года в Варшаве." },
  { title: "Дубль", url: "https://www.nobelprize.org/curie", content: "…" },
  { title: "Плохая ссылка", url: "javascript:alert(1)", content: "…" },
  { title: "Сама статья", url: "https://news.example.test/curie", content: "Перепечатка" },
];

function scenario(searchJson: (c: Call) => { status?: number; json?: unknown; throws?: Error }) {
  return fakeFetch((c) => {
    if (!isChat(c)) return searchJson(c);
    if (system(c).startsWith("Составь поисковые запросы")) return chatReply({ queries: ["Кюри дата рождения", "Склодовская 1867 Варшава", "третий запрос"] });
    return chatReply({ verdict: "supported", explanation: "Подтверждается биографией.", sources: [{ index: 1, role: "primary", relation: "Биография" }, { index: 2, role: "secondary", relation: "x" }] });
  });
}

describe("Ollama + SearXNG: модель локально, источники — только из поиска", () => {
  test("ровно 2 запроса на утверждение, GET к SearXNG без ключей; ссылки — из результатов поиска", async () => {
    const { f, calls } = scenario(() => ({ json: { results: RESULTS } }));
    const search = new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: f });
    const outcome = await checker(f, search).checkClaim(input);

    const searches = calls.filter((c) => c.url.startsWith(SEARXNG));
    expect(searches).toHaveLength(2);
    expect(outcome.searchQueries).toEqual(["Кюри дата рождения", "Склодовская 1867 Варшава"]);
    const url = new URL(searches[0]!.url);
    expect([url.pathname, url.searchParams.get("q"), url.searchParams.get("format")]).toEqual(["/search", "Кюри дата рождения", "json"]);
    expect(searches[0]!.headers.Authorization).toBeUndefined();
    for (const c of calls.filter(isChat)) expect(c.body).toMatchObject({ model: "qwen3:14b", stream: false, think: false, options: { temperature: 0 } });

    expect(outcome.citations.map((c) => c.url)).toEqual(["https://www.nobelprize.org/curie", "https://news.example.test/curie"]);
    // Источник с сайта самой статьи отбрасывается при решении.
    const d = decideVerdict({ ...outcome, interactionId: null, retrievedAt: "2026-10-25T12:00:00Z", articleUrl: input.article.url });
    expect(d.verdict).toBe("supported");
    expect(d.evidence.map((e) => e.url)).toEqual(["https://www.nobelprize.org/curie"]);
  });

  test("SearXNG без JSON (403) — фатальная ошибка с подсказкой; не запущен — понятный текст", async () => {
    const forbidden = scenario(() => ({ status: 403, json: {} }));
    const s1 = new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: forbidden.f });
    await expect(checker(forbidden.f, s1).checkClaim(input)).rejects.toMatchObject({ kind: "not_configured", fatal: true, userText: expect.stringMatching(/settings\.yml/) });

    const down = scenario(() => ({ throws: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }) }));
    const s2 = new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: down.f });
    await expect(checker(down.f, s2).checkClaim(input)).rejects.toMatchObject({ kind: "unavailable", userText: expect.stringMatching(/npm run searxng:up/) });
  });

  test("поиск без результатов — insufficient без вызова вердикта", async () => {
    const { f, calls } = scenario(() => ({ json: { results: [] } }));
    const search = new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: f });
    expect((await checker(f, search).checkClaim(input)).verdict).toBe("insufficient");
    expect(calls.filter(isChat)).toHaveLength(1);
  });
});

describe("Ollama Web Search как запасной поиск", () => {
  test("ключ уходит только на ollama.com, а не в локальную модель", async () => {
    const { f, calls } = scenario(() => ({ json: { results: RESULTS } }));
    const search = new OllamaWebSearch({ apiKey: KEY, retry: fast, perQuery: 5, fetch: f });
    await checker(f, search, 1).checkClaim(input);
    const web = calls.filter((c) => c.url === WEB_SEARCH_URL);
    expect(web).toHaveLength(1);
    expect(web[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(web[0]!.body).toEqual({ query: "Кюри дата рождения", max_results: 5 });
    for (const c of calls.filter(isChat)) expect(JSON.stringify(c)).not.toContain(KEY);
  });

  test("нет ключа — фатальная ошибка auth; нет модели — not_configured", async () => {
    const noKey = scenario(() => ({ json: {} }));
    await expect(checker(noKey.f, new OllamaWebSearch({ apiKey: null, retry: fast, perQuery: 5, fetch: noKey.f })).checkClaim(input)).rejects.toMatchObject({ kind: "auth", fatal: true });
    const noModel = fakeFetch(() => ({ status: 404, json: { error: "model 'qwen3:14b' not found" } }));
    const search = new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: noModel.f });
    await expect(checker(noModel.f, search).extractClaims(input.article, [])).rejects.toMatchObject({ kind: "not_configured", fatal: true });
  });
});

test("готовность SearXNG проверяется без настоящего поиска", async () => {
  const ready = fakeFetch(() => ({ status: 400, json: { error: "No query" } }));
  expect(await new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: ready.f }).problem()).toBeNull();
  const url = new URL(ready.calls[0]!.url);
  expect([url.pathname, url.searchParams.get("format"), url.searchParams.has("q")]).toEqual(["/search", "json", false]);

  const noJson = fakeFetch(() => ({ status: 403 }));
  expect(await new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: noJson.f }).problem()).toMatch(/settings\.yml/);
  const down = fakeFetch(() => ({ throws: new TypeError("fetch failed") }));
  expect(await new SearxngSearch({ baseUrl: SEARXNG, retry: fast, perQuery: 5, fetch: down.f }).problem()).toMatch(/npm run searxng:up/);
});

test("health сообщает, что мешает проверке: Ollama, модель или поиск", async () => {
  const okSearch: SearchProvider = { name: "searxng", search: async () => [], problem: async () => null };
  const badSearch: SearchProvider = { ...okSearch, problem: async () => "SearXNG недоступен" };
  const base = { host: OLLAMA, model: "qwen3:14b", search: okSearch };
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  expect(await ollamaProblem({ ...base, fetch: down })).toMatch(/не запущена/);
  const other = fakeFetch(() => ({ json: { models: [{ name: "llama3:latest" }] } }));
  expect(await ollamaProblem({ ...base, fetch: other.f })).toMatch(/ollama pull qwen3:14b/);
  const ready = fakeFetch(() => ({ json: { models: [{ name: "qwen3:14b" }] } }));
  expect(await ollamaProblem({ ...base, search: badSearch, fetch: ready.f })).toBe("SearXNG недоступен");
  expect(await ollamaProblem({ ...base, fetch: ready.f })).toBeNull();
});
