import { describe, expect, test } from "vitest";
import type { Claim, ExtractedArticle } from "../../shared/contract.ts";
import { type ClaudeOptions, type ClaudeResult, ClaudeError, childEnv, claudeArgs, parseEvents } from "../src/claude.ts";
import { DEFAULT_OPTIONS, type HostEvent, analyze, verdictFromCheck } from "../src/pipeline.ts";
import { createDecoder, encode } from "../src/protocol.ts";

// Строки stream-json в том виде, в каком их печатает `claude -p --output-format stream-json --verbose`.
const STREAM = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-5", tools: ["StructuredOutput", "WebSearch"] }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "Кюри дата рождения" } }] } }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: "Web search results…" }] },
    tool_use_result: {
      query: "Кюри дата рождения",
      results: [
        { tool_use_id: "s1", content: [{ title: "Nobel", url: "https://www.nobelprize.org/curie/" }, { title: "bad", url: "javascript:alert(1)" }] },
        "Текстовый комментарий поиска без ссылок",
        { tool_use_id: "s2", content: [{ title: "Nobel", url: "https://www.nobelprize.org/curie/" }, { title: "Wiki", url: "https://ru.wikipedia.org/wiki/Кюри" }] },
      ],
    },
  }),
  "не JSON — пропускается",
  JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.03, result: "{}", structured_output: { verdict: "contradicted" } }),
];

describe("разбор вывода Claude Code", () => {
  test("ссылки — из результатов WebSearch по полям, без дублей и не-http", () => {
    const r = parseEvents(STREAM);
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.searchQueries).toEqual(["Кюри дата рождения"]);
    expect(r.searchHits).toEqual([
      { url: "https://www.nobelprize.org/curie/", title: "Nobel" },
      { url: "https://ru.wikipedia.org/wiki/Кюри", title: "Wiki" },
    ]);
    expect(r.structured).toEqual({ verdict: "contradicted" });
    expect(r.costUsd).toBe(0.03);
    expect(r.isError).toBe(false);
  });

  test("ошибка входа распознаётся", () => {
    const r = parseEvents([JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" })]);
    expect(r.isError).toBe(true);
    expect(r.error).toMatch(/Not logged in/);
  });

  test("изоляция: только перечисленные инструменты, без пользовательских настроек, MCP и сессии", () => {
    const args = claudeArgs({ prompt: "p", systemPrompt: "s", model: "sonnet", tools: ["WebSearch"], maxBudgetUsd: 0.5 });
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    expect(after("--tools")).toBe("WebSearch");
    expect(after("--allowedTools")).toBe("WebSearch");
    expect(after("--setting-sources")).toBe("");
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-session-persistence", "--max-budget-usd"]));
    expect(args).not.toContain("--dangerously-skip-permissions");
    // Без инструментов: пустой белый список и никаких разрешений.
    const none = claudeArgs({ prompt: "p", systemPrompt: "s", model: "haiku", tools: [] });
    expect(none[none.indexOf("--tools") + 1]).toBe("");
    expect(none).not.toContain("--allowedTools");
  });

  test("окружение процесса собирается заново: только вход по подписке, без переменных браузера", () => {
    const env = childEnv({ HOME: "/home/u", USER: "u", LOGNAME: "u", PATH: "/opt/x", SECRET_TOKEN: "x", LANG: "ru_RU.UTF-8" });
    expect(env).toEqual({ HOME: "/home/u", USER: "u", LOGNAME: "u", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "ru_RU.UTF-8" });
    // Браузер не передал USER и HOME — берутся из системы, иначе вход в Claude Code не читается.
    const fallback = childEnv({});
    expect(fallback.USER).toBeTruthy();
    expect(fallback.HOME).toBeTruthy();
  });
});

test("протокол: кадры разбираются и при разрезанных данных", () => {
  const got: unknown[] = [];
  const decode = createDecoder((m) => got.push(m));
  const bytes = Buffer.concat([encode({ type: "ping" }), encode({ type: "analyze", id: "a", text: "Кюри" })]);
  decode(bytes.subarray(0, 3));
  decode(bytes.subarray(3, 20));
  decode(bytes.subarray(20));
  expect(got).toEqual([{ type: "ping" }, { type: "analyze", id: "a", text: "Кюри" }]);
});

const baseClaim: Claim = {
  id: "c1",
  blockIds: ["b2"],
  exactText: "x",
  occurrences: [{ blockId: "b2", exactText: "x" }],
  normalizedClaim: "Кюри родилась в 1869 году",
  kind: "date",
  status: "checking",
  verdict: null,
  explanation: null,
  evidence: [],
};

const result = (structured: unknown, hits: { url: string; title: string | null }[], queries = ["q"]): ClaudeResult => ({
  structured,
  text: "",
  costUsd: 0.02,
  durationMs: 10,
  model: "m",
  tools: [],
  searchHits: hits,
  searchQueries: queries,
});

describe("вердикт по результатам поиска", () => {
  test("ссылки модели принимаются, только если они были в результатах поиска; сайт статьи не считается", () => {
    const claim = verdictFromCheck(
      baseClaim,
      result(
        {
          verdict: "contradicted",
          explanation: "Родилась в 1867.",
          sources: [
            { url: "https://www.nobelprize.org/curie", role: "primary", relation: "Биография" },
            { url: "https://invented.example/fake", role: "secondary", relation: "выдумана моделью" },
            { url: "https://news.example.test/curie", role: "secondary", relation: "сама статья" },
          ],
        },
        [
          { url: "https://www.nobelprize.org/curie/", title: "Nobel" },
          { url: "https://news.example.test/curie", title: "Статья" },
        ],
      ),
      "https://news.example.test/article",
      "2026-10-26T10:00:00Z",
    );
    expect(claim.verdict).toBe("contradicted");
    expect(claim.evidence.map((e) => e.url)).toEqual(["https://www.nobelprize.org/curie/"]);
  });

  test("вердикт без ссылки из поиска понижается до insufficient", () => {
    const claim = verdictFromCheck(baseClaim, result({ verdict: "supported", explanation: "По памяти.", sources: [] }, []), "https://a.test/", "2026-10-26T10:00:00Z");
    expect(claim.verdict).toBe("insufficient");
  });
});

/** ТЕСТОВАЯ ЗАГЛУШКА claude: ответы по сценарию, без сети. В работе вызывается настоящий `claude -p`. */
function fakeRunner(script: (o: ClaudeOptions, n: number) => ClaudeResult | Error) {
  const calls: ClaudeOptions[] = [];
  const runner = async (o: ClaudeOptions) => {
    calls.push(o);
    const r = script(o, calls.length);
    if (r instanceof Error) throw r;
    return r;
  };
  return { runner, calls };
}

const article: ExtractedArticle = {
  schemaVersion: 1,
  url: "https://news.example.test/a",
  canonicalUrl: null,
  language: "ru",
  pageType: "article",
  metadata: { title: "Кюри", subtitle: null, authors: [], publishedAt: null, modifiedAt: null },
  blocks: [
    { id: "b1", type: "title", order: 1, text: "Мария Кюри", links: [] },
    { id: "b2", type: "paragraph", order: 2, text: "Кюри родилась в 1869 году. Они поженились в 1895 году. Это великая учёная.", links: [] },
  ],
  extraction: { status: "ok", method: "x", warnings: [] },
};

const extractAnswer = result(
  {
    claims: [
      { occurrences: [{ blockId: "b2", exactText: "Кюри родилась в 1869 году." }], normalizedClaim: "Кюри родилась в 1869 году", kind: "date", isOpinion: false },
      { occurrences: [{ blockId: "b2", exactText: "Они поженились в 1895 году." }], normalizedClaim: "Кюри поженились в 1895 году", kind: "date", isOpinion: false },
      { occurrences: [{ blockId: "b2", exactText: "Это великая учёная." }], normalizedClaim: "Кюри — великая учёная", kind: "other", isOpinion: true },
    ],
  },
  [],
  [],
);

describe("конвейер", () => {
  test("haiku выделяет, sonnet с WebSearch проверяет; ответ без поиска переспрашивается один раз", async () => {
    let checks = 0;
    const { runner, calls } = fakeRunner((o) => {
      if (o.jsonSchema && "claims" in ((o.jsonSchema as any).properties ?? {})) return extractAnswer;
      if (o.tools.includes("WebSearch")) {
        checks++;
        // Первая проверка сначала отвечает «по памяти», без поиска.
        if (checks === 1) return result({ verdict: "supported", explanation: "по памяти", sources: [] }, [], []);
        return result({ verdict: "supported", explanation: "ок", sources: [{ url: "https://src.example/1", role: "secondary", relation: "r" }] }, [{ url: "https://src.example/1", title: "S" }]);
      }
      return { ...result(null, []), text: "Сводка." };
    });
    const events: HostEvent[] = [];
    await analyze("a1", article, { ...DEFAULT_OPTIONS, claudeBin: "claude", concurrency: 1 }, (e) => events.push(e), new AbortController().signal, runner);

    expect(calls[0]!.model).toBe("haiku");
    expect(calls[0]!.tools).toEqual([]);
    const checkCalls = calls.filter((c) => c.tools.includes("WebSearch"));
    expect(checkCalls.every((c) => c.model === "sonnet")).toBe(true);
    expect(checkCalls).toHaveLength(3);
    expect(checkCalls[1]!.prompt.startsWith("Ты не выполнил поиск")).toBe(true);

    const claims = events.find((e) => e.type === "claims") as Extract<HostEvent, { type: "claims" }>;
    expect(claims.claims.map((c) => c.status)).toEqual(["queued", "queued", "opinion"]);
    const final = new Map<string, Claim>();
    for (const e of events) if (e.type === "claim") final.set(e.claim.id, e.claim);
    expect([...final.values()].map((c) => [c.id, c.status, c.verdict])).toEqual([
      ["c1", "checked", "supported"],
      ["c2", "checked", "supported"],
    ]);
    expect(events.at(-1)).toEqual({ type: "stage", id: "a1", status: "completed" });
    expect(events.some((e) => e.type === "summary")).toBe(true);
  });

  test("лимит Claude останавливает остальные проверки с понятной причиной", async () => {
    const { runner } = fakeRunner((o) => (o.tools.includes("WebSearch") ? new ClaudeError("rate_limited", "Достигнут лимит Claude: повторите проверку позже.") : extractAnswer));
    const events: HostEvent[] = [];
    await analyze("a2", article, { ...DEFAULT_OPTIONS, claudeBin: "claude", concurrency: 1 }, (e) => events.push(e), new AbortController().signal, runner);
    const final = new Map<string, Claim>();
    for (const e of events) if (e.type === "claim") final.set(e.claim.id, e.claim);
    expect([...final.values()].map((c) => c.status)).toEqual(["failed", "failed"]);
    expect(events.at(-1)).toMatchObject({ type: "stage", status: "completed", error: expect.stringMatching(/лимит/) });
  });

  test("отмена во время выделения утверждений — статус «отменено», а не ошибка", async () => {
    const controller = new AbortController();
    const { runner } = fakeRunner(() => {
      controller.abort();
      return new ClaudeError("cancelled", "Отменено");
    });
    const events: HostEvent[] = [];
    await analyze("a4", article, { ...DEFAULT_OPTIONS, claudeBin: "claude" }, (e) => events.push(e), controller.signal, runner);
    expect(events.at(-1)).toEqual({ type: "stage", id: "a4", status: "cancelled" });
  });

  test("отмена: начатые и ожидающие проверки — not_checked", async () => {
    const controller = new AbortController();
    const { runner } = fakeRunner((o) => {
      if (o.tools.includes("WebSearch")) {
        controller.abort();
        return new ClaudeError("cancelled", "Отменено");
      }
      return extractAnswer;
    });
    const events: HostEvent[] = [];
    await analyze("a3", article, { ...DEFAULT_OPTIONS, claudeBin: "claude", concurrency: 1 }, (e) => events.push(e), controller.signal, runner);
    const final = new Map<string, Claim>();
    for (const e of events) if (e.type === "claim") final.set(e.claim.id, e.claim);
    expect([...final.values()].map((c) => c.status)).toEqual(["not_checked", "not_checked"]);
    expect(events.at(-1)).toEqual({ type: "stage", id: "a3", status: "cancelled" });
  });
});
