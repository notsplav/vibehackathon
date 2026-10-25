// SearXNG: локальный метапоиск (npm run searxng:up). Ключ не нужен; сервер обращается только к SEARXNG_URL из конфигурации.

import { ModelError } from "../llm/errors.ts";
import { type RetryPolicy, withRetry } from "../llm/retry.ts";
import { type SearchProvider, type SearchResult, cleanResults } from "./types.ts";

const TIMEOUT_MS = 20_000;

export class SearxngSearch implements SearchProvider {
  readonly name = "searxng" as const;
  private readonly baseUrl: string;
  private readonly retry: RetryPolicy;
  private readonly perQuery: number;
  private readonly fetch: typeof fetch;

  constructor(opts: { baseUrl: string; retry: RetryPolicy; perQuery: number; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl;
    this.retry = opts.retry;
    this.perQuery = opts.perQuery;
    this.fetch = opts.fetch ?? fetch;
  }

  private url(query: string): URL {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "0");
    return url;
  }

  private async request(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    let res: Response;
    try {
      res = await this.fetch(this.url(query), {
        headers: { Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      const timeout = (e as { name?: string })?.name === "TimeoutError";
      throw new ModelError(timeout ? "timeout" : "unavailable", String(e), null, null, timeout
        ? "SearXNG не ответил вовремя."
        : `SearXNG недоступен на ${this.baseUrl}: запустите его командой npm run searxng:up.`);
    }
    if (res.status === 403) {
      throw new ModelError("not_configured", "HTTP 403", 403, null, "SearXNG отклоняет JSON-запросы: проверьте searxng/settings.yml (search.formats: json, server.limiter: false) и перезапустите.");
    }
    if (res.status === 429) throw new ModelError("rate_limited", "HTTP 429", 429, null, "SearXNG ограничил частоту запросов (429).");
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const data = (await res.json()) as { results?: unknown };
    return cleanResults(Array.isArray(data?.results) ? data.results : [], this.perQuery);
  }

  search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    return withRetry(() => this.request(query, signal), this.retry, null, signal);
  }

  async problem(): Promise<string | null> {
    try {
      await this.request("проверка", AbortSignal.timeout(5000));
      return null;
    } catch (e) {
      return e instanceof ModelError && e.userText ? e.userText : `SearXNG недоступен на ${this.baseUrl}.`;
    }
  }
}
