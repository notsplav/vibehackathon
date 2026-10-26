// Запуск Claude Code в неинтерактивном режиме (`claude -p`) и разбор его потока событий.
// Текст статьи — недоверенный ввод, а Claude Code — агент, поэтому каждый запуск изолирован:
// только перечисленные инструменты, пустая временная папка, без пользовательских настроек и хуков,
// без MCP-серверов, без сохранения сессии и с потолком трат.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SearchHit {
  url: string;
  title: string | null;
}

export interface ClaudeResult {
  /** Ответ по --json-schema. */
  structured: unknown;
  text: string;
  costUsd: number;
  durationMs: number;
  model: string | null;
  tools: string[];
  /** Ссылки из результатов WebSearch — единственный допустимый источник свидетельств. */
  searchHits: SearchHit[];
  searchQueries: string[];
}

export interface ClaudeOptions {
  bin: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  /** Встроенные инструменты; пустой список — без инструментов. */
  tools: string[];
  jsonSchema?: object;
  maxTurns?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  /** Шаги для живого прогресса: агент начал поиск. */
  onSearch?: (query: string) => void;
}

export class ClaudeError extends Error {
  readonly kind: "not_logged_in" | "rate_limited" | "budget" | "not_found" | "failed" | "cancelled";

  constructor(kind: ClaudeError["kind"], message: string) {
    super(message);
    this.name = "ClaudeError";
    this.kind = kind;
  }

  /** После этих ошибок остальные проверки запускать бессмысленно. */
  get fatal(): boolean {
    return this.kind === "not_logged_in" || this.kind === "not_found" || this.kind === "rate_limited";
  }
}

/**
 * Окружение процесса: только то, что нужно для входа по подписке. USER и LOGNAME обязательны —
 * без них Claude Code не читает учётные данные из Связки ключей macOS. Окружение браузера не наследуется.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const user = base.USER || base.LOGNAME || "";
  return {
    HOME: base.HOME ?? "",
    USER: user,
    LOGNAME: base.LOGNAME || user,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: base.LANG || "en_US.UTF-8",
    ...(base.TMPDIR ? { TMPDIR: base.TMPDIR } : {}),
  };
}

export function claudeArgs(o: Omit<ClaudeOptions, "bin" | "signal" | "onSearch">): string[] {
  const args = [
    "-p",
    o.prompt,
    "--system-prompt",
    o.systemPrompt,
    "--model",
    o.model,
    // Белый список: только эти инструменты доступны и разрешены.
    "--tools",
    o.tools.join(","),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (o.tools.length) args.push("--allowedTools", o.tools.join(","));
  if (o.jsonSchema) args.push("--json-schema", JSON.stringify(o.jsonSchema));
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.maxBudgetUsd) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  return args;
}

/** Разбор строк stream-json. Чистая функция: используется и в работе, и в тестах. */
export function parseEvents(lines: string[]): Omit<ClaudeResult, "durationMs"> & { error: string | null; isError: boolean } {
  const out = { structured: null as unknown, text: "", costUsd: 0, model: null as string | null, tools: [] as string[], searchHits: [] as SearchHit[], searchQueries: [] as string[], error: null as string | null, isError: false };
  const seen = new Set<string>();
  for (const line of lines) {
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "system" && e.subtype === "init") {
      out.model = typeof e.model === "string" ? e.model : null;
      out.tools = Array.isArray(e.tools) ? e.tools : [];
    }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c?.type === "tool_use" && c.name === "WebSearch" && typeof c.input?.query === "string") out.searchQueries.push(c.input.query);
      }
    }
    // Результат WebSearch: tool_use_result.results[].content[] = { title, url }.
    const results = e.type === "user" ? e.tool_use_result?.results : null;
    if (Array.isArray(results)) {
      for (const r of results) {
        for (const hit of Array.isArray(r?.content) ? r.content : []) {
          if (typeof hit?.url !== "string" || !/^https?:\/\//i.test(hit.url) || seen.has(hit.url)) continue;
          seen.add(hit.url);
          out.searchHits.push({ url: hit.url, title: typeof hit.title === "string" && hit.title.trim() ? hit.title.trim().slice(0, 300) : null });
        }
      }
    }
    if (e.type === "result") {
      out.costUsd = typeof e.total_cost_usd === "number" ? e.total_cost_usd : 0;
      out.text = typeof e.result === "string" ? e.result : "";
      out.structured = e.structured_output ?? null;
      out.isError = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success");
      if (out.isError) out.error = out.text || String(e.subtype ?? "error");
    }
  }
  return out;
}

function classify(message: string): ClaudeError {
  if (/not logged in|\/login|invalid api key|authentication/i.test(message)) return new ClaudeError("not_logged_in", "Claude Code не авторизован: запустите claude в терминале и выполните /login.");
  if (/rate limit|usage limit|limit reached|429|overloaded/i.test(message)) return new ClaudeError("rate_limited", "Достигнут лимит Claude: повторите проверку позже.");
  if (/budget/i.test(message)) return new ClaudeError("budget", "Превышен лимит трат на одну проверку.");
  return new ClaudeError("failed", `Claude Code завершился с ошибкой: ${message.slice(0, 300)}`);
}

export async function runClaude(o: ClaudeOptions): Promise<ClaudeResult> {
  if (o.signal?.aborted) throw new ClaudeError("cancelled", "Отменено");
  // Пустая временная папка: никаких файлов проекта и CLAUDE.md рядом с агентом.
  const cwd = await mkdtemp(join(tmpdir(), "sverka-"));
  const started = Date.now();
  try {
    return await new Promise<ClaudeResult>((resolve, reject) => {
      let child;
      try {
        // stdin закрыт сразу: иначе claude ждёт ввода 3 секунды.
        child = spawn(o.bin, claudeArgs(o), { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        reject(new ClaudeError("not_found", `Claude Code не найден: ${o.bin}`));
        return;
      }
      const lines: string[] = [];
      let buf = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          lines.push(line);
          if (o.onSearch && line.includes('"WebSearch"')) {
            for (const q of parseEvents([line]).searchQueries) o.onSearch(q);
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-2000)));
      const abort = () => child.kill("SIGTERM");
      o.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (err: NodeJS.ErrnoException) =>
        reject(err.code === "ENOENT" ? new ClaudeError("not_found", `Claude Code не найден: ${o.bin}`) : classify(String(err.message))),
      );
      child.on("close", (code) => {
        o.signal?.removeEventListener("abort", abort);
        if (buf.trim()) lines.push(buf);
        if (o.signal?.aborted) return reject(new ClaudeError("cancelled", "Отменено"));
        const parsed = parseEvents(lines);
        if (parsed.isError || (code !== 0 && parsed.structured === null)) return reject(classify(parsed.error ?? stderr ?? `код ${code}`));
        resolve({ ...parsed, durationMs: Date.now() - started });
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
