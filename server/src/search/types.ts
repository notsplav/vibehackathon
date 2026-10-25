// Поиск источников для провайдера Ollama. Ссылки для свидетельств берутся только отсюда, а не из текста модели.

export interface SearchResult {
  title: string | null;
  url: string;
  /** Фрагмент текста страницы, который увидит модель. */
  content: string | null;
}

export interface SearchProvider {
  readonly name: "searxng" | "ollama";
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
  /** Почему поиск сейчас невозможен (для /api/health); null — всё готово. */
  problem(): Promise<string | null>;
}

/** Оставляет только http(s)-ссылки с непустым URL. */
export function cleanResults(raw: unknown[], limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of raw) {
    const item = r as { title?: unknown; url?: unknown; content?: unknown };
    if (typeof item?.url !== "string" || !/^https?:\/\//i.test(item.url)) continue;
    out.push({
      url: item.url,
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 300) : null,
      content: typeof item.content === "string" && item.content.trim() ? item.content.trim() : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}
