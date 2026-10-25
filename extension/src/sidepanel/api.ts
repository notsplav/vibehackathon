// Обращения к локальному серверу. Ключ Gemini здесь не используется и не хранится.

import type { AnalysisState, CreateAnalysisResponse, ExtractedArticle, HealthResponse } from "../../../shared/contract.ts";
import { SERVER_URL } from "../messages.ts";

export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Локальный сервер недоступен (127.0.0.1:8787). Запустите его командой npm run dev:server.", null);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Ошибка сервера ${res.status}`, res.status);
  return data as T;
}

export const api = {
  health: () => call<HealthResponse>("GET", "/api/health"),
  create: (article: ExtractedArticle, force: boolean) => call<CreateAnalysisResponse>("POST", `/api/analyses${force ? "?force=1" : ""}`, article),
  get: (id: string) => call<AnalysisState>("GET", `/api/analyses/${id}`),
  cancel: (id: string) => call<AnalysisState>("POST", `/api/analyses/${id}/cancel`),
  remove: (id: string) => call<void>("DELETE", `/api/analyses/${id}`),
};
