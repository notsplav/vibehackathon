// Ollama Web Search: облачный поиск ollama.com, нужен OLLAMA_API_KEY. Лимиты бесплатного аккаунта не опубликованы.

import { ModelError } from "../llm/errors.ts";
import { type RetryPolicy, withRetry } from "../llm/retry.ts";
import { type SearchProvider, type SearchResult, cleanResults } from "./types.ts";

export const WEB_SEARCH_URL = "https://ollama.com/api/web_search";
const TIMEOUT_MS = 30_000;

export class OllamaWebSearch implements SearchProvider {
  readonly name = "ollama" as const;
  private readonly apiKey: string | null;
  private readonly retry: RetryPolicy;
  private readonly fetch: typeof fetch;
  private readonly perQuery: number;

  constructor(opts: { apiKey: string | null; retry: RetryPolicy; perQuery: number; fetch?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.retry = opts.retry;
    this.perQuery = opts.perQuery;
    this.fetch = opts.fetch ?? fetch;
  }

  async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
    const key = this.apiKey;
    if (!key) throw new ModelError("auth", "OLLAMA_API_KEY не задан", null, null, "OLLAMA_API_KEY не задан: веб-поиск Ollama недоступен.");
    return withRetry(
      async () => {
        const res = await this.fetch(WEB_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, max_results: this.perQuery }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status === 401 || res.status === 403) {
          throw new ModelError("auth", `HTTP ${res.status}`, res.status, null, "OLLAMA_API_KEY недействителен: веб-поиск Ollama недоступен.");
        }
        if (res.status === 429) {
          throw new ModelError("rate_limited", "HTTP 429", 429, null, "Лимит Ollama Web Search исчерпан (429). Переключитесь на SEARCH_PROVIDER=searxng.");
        }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        const data = (await res.json()) as { results?: unknown };
        return cleanResults(Array.isArray(data?.results) ? data.results : [], this.perQuery);
      },
      this.retry,
      key,
      signal,
    );
  }

  async problem(): Promise<string | null> {
    return this.apiKey ? null : "OLLAMA_API_KEY не задан: без веб-поиска утверждения нельзя проверить по источникам.";
  }
}
