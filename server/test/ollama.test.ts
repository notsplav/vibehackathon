import { describe, expect, test } from "vitest";
import { OllamaFactChecker, WEB_SEARCH_URL, ollamaProblem } from "../src/ollama/client.ts";
import { decideVerdict } from "../src/pipeline/evidence.ts";

const KEY = "test-ollama-key";
const fast = { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * ТЕСТОВАЯ ПОДМЕНА fetch: отвечает как Ollama (/api/chat) и Ollama Web Search по сценарию.
 * В работе сервер обращается к настоящим сервисам и не подставляет такие данные.
 */
function fakeFetch(handler: (call: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const { status = 200, json = {} } = handler(call);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

const chatReply = (content: unknown) => ({ json: { message: { role: "assistant", content: JSON.stringify(content) }, done: true } });

function checker(f: typeof fetch, apiKey: string | null = KEY) {
  return new OllamaFactChecker({ host: "http://127.0.0.1:11434", model: "qwen3:14b", apiKey, numCtx: 16384, retry: fast, fetch: f });
}

const input = {
  claim: "Мария Кюри родилась 7 ноября 1867 года в Варшаве",
  kind: "date" as const,
  context: ["Мария Склодовская-Кюри родилась 7 ноября 1867 года в Варшаве."],
  article: { title: "Мария Кюри", publishedAt: null, url: "https://news.example.test/curie" },
};

describe("Ollama: модель локально, источники — только из веб-поиска", () => {
  test("ключ уходит только на ollama.com; источники — из результатов поиска; модель ссылается на номера", async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.url === WEB_SEARCH_URL) {
        return {
          json: {
            results: [
              { title: "Мария Кюри — биография", url: "https://www.nobelprize.org/curie", content: "Родилась 7 ноября 1867 года в Варшаве." },
              { title: "Дубль", url: "https://www.nobelprize.org/curie", content: "…" },
              { title: "Плохая ссылка", url: "javascript:alert(1)", content: "…" },
              { title: "Сама статья", url: "https://news.example.test/curie", content: "Перепечатка" },
            ],
          },
        };
      }
      const system = c.body.messages[0].content as string;
      if (system.startsWith("Составь поисковые запросы")) return chatReply({ queries: ["Мария Кюри дата рождения"] });
      return chatReply({ verdict: "supported", explanation: "Подтверждается биографией.", sources: [{ index: 1, role: "primary", relation: "Биография" }, { index: 2, role: "secondary", relation: "x" }] });
    });
    const outcome = await checker(f).checkClaim(input);

    const local = calls.filter((c) => c.url.startsWith("http://127.0.0.1:11434"));
    const search = calls.filter((c) => c.url === WEB_SEARCH_URL);
    expect(local).toHaveLength(2);
    expect(search).toHaveLength(1);
    for (const c of local) {
      expect(c.headers.Authorization).toBeUndefined();
      expect(JSON.stringify(c.body)).not.toContain(KEY);
      expect(c.body).toMatchObject({ model: "qwen3:14b", stream: false, think: false, options: { temperature: 0 } });
      expect(c.body.format).toBeTypeOf("object");
    }
    expect(search[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(search[0]!.body).toEqual({ query: "Мария Кюри дата рождения", max_results: 5 });

    expect(outcome.citations.map((c) => c.url)).toEqual(["https://www.nobelprize.org/curie", "https://news.example.test/curie"]);
    // Источник с сайта самой статьи отбрасывается при решении.
    const d = decideVerdict({ ...outcome, interactionId: null, retrievedAt: "2026-10-25T12:00:00Z", articleUrl: input.article.url });
    expect(d.verdict).toBe("supported");
    expect(d.evidence.map((e) => e.url)).toEqual(["https://www.nobelprize.org/curie"]);
  });

  test("поиск без результатов — insufficient без вызова вердикта", async () => {
    const { f, calls } = fakeFetch((c) => (c.url === WEB_SEARCH_URL ? { json: { results: [] } } : chatReply({ queries: ["запрос"] })));
    const outcome = await checker(f).checkClaim(input);
    expect(outcome.verdict).toBe("insufficient");
    expect(calls.filter((c) => c.url.includes("/api/chat"))).toHaveLength(1);
  });

  test("нет ключа или неверный ключ — фатальная ошибка auth; нет модели — not_configured", async () => {
    const noKey = fakeFetch(() => chatReply({ queries: ["q"] }));
    await expect(checker(noKey.f, null).checkClaim(input)).rejects.toMatchObject({ kind: "auth", fatal: true });

    const badKey = fakeFetch((c) => (c.url === WEB_SEARCH_URL ? { status: 401, json: { error: "unauthorized" } } : chatReply({ queries: ["q"] })));
    await expect(checker(badKey.f).checkClaim(input)).rejects.toMatchObject({ kind: "auth" });

    const noModel = fakeFetch(() => ({ status: 404, json: { error: "model 'qwen3:14b' not found" } }));
    await expect(checker(noModel.f).extractClaims(input.article, [])).rejects.toMatchObject({ kind: "not_configured", fatal: true });
  });

  test("health сообщает, что мешает проверке", async () => {
    const base = { host: "http://127.0.0.1:11434", model: "qwen3:14b", apiKey: KEY };
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await ollamaProblem({ ...base, fetch: down })).toMatch(/не запущена/);
    const empty = fakeFetch(() => ({ json: { models: [{ name: "llama3:latest" }] } }));
    expect(await ollamaProblem({ ...base, fetch: empty.f })).toMatch(/ollama pull qwen3:14b/);
    const ready = fakeFetch(() => ({ json: { models: [{ name: "qwen3:14b" }] } }));
    expect(await ollamaProblem({ ...base, fetch: ready.f, apiKey: null })).toMatch(/OLLAMA_API_KEY/);
    expect(await ollamaProblem({ ...base, fetch: ready.f })).toBeNull();
  });
});
