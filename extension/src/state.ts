// Хранение проверок в chrome.storage.local и сообщения панели фоновому скрипту.
// Состояние пишет только фоновый скрипт; панель читает его и подписывается на изменения.

import type { AnalysisState, Claim, ExtractedArticle } from "../../shared/contract.ts";
import { computeStats } from "../../core/stats.ts";

/** Последняя проверка страницы: какой анализ показывать и с каким отпечатком текста он сделан. */
export interface PageEntry {
  analysisId: string;
  fingerprint: string;
}

export function pageKey(url: string): string {
  return `page:${url.split("#")[0]}`;
}

export function analysisKey(id: string): string {
  return `analysis:${id}`;
}

export interface HostStatus {
  /** Помощник установлен и отвечает. */
  ready: boolean;
  /** Почему проверка невозможна. */
  problem: string | null;
  extractModel: string | null;
  checkModel: string | null;
}

export type BgRequest =
  | { type: "bg:start"; url: string; article: ExtractedArticle; fingerprint: string }
  | { type: "bg:cancel"; analysisId: string }
  | { type: "bg:delete"; analysisId: string; url: string }
  | { type: "bg:status" };

export type BgReply = { ok: true; analysisId?: string; status?: HostStatus } | { ok: false; error: string };

export function newAnalysis(id: string, article: ExtractedArticle): AnalysisState {
  const now = new Date().toISOString();
  return {
    analysisId: id,
    status: "queued",
    focus: article.focus ?? null,
    preliminary: true,
    url: article.url,
    canonicalUrl: article.canonicalUrl,
    metadata: article.metadata,
    claims: [],
    stats: computeStats([]),
    summary: null,
    error: null,
    live: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Пересчитывает статистику и признак незавершённости после изменения claims или статуса. */
export function withClaims(state: AnalysisState, claims: Claim[]): AnalysisState {
  const terminal = state.status === "completed" || state.status === "failed" || state.status === "cancelled";
  return {
    ...state,
    claims,
    stats: computeStats(claims),
    preliminary: !terminal || claims.some((c) => c.status === "queued" || c.status === "checking"),
    updatedAt: new Date().toISOString(),
  };
}
