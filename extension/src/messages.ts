// Сообщения между боковой панелью и content script.

import type { Claim, ExtractedArticle } from "../../shared/contract.ts";

export type PanelMessage =
  | { type: "vh:extract" }
  /** Проверка выделенного фрагмента; hint — текст выделения из контекстного меню на случай, если выделение снято. */
  | { type: "vh:extract-selection"; hint: string | null; onlyHint?: boolean }
  | { type: "vh:render"; claims: Claim[]; fingerprint: string }
  | { type: "vh:focus"; blockId: string }
  | { type: "vh:clear" };

export type ExtractReply = { ok: true; article: ExtractedArticle; fingerprint: string } | { ok: false; error: string };
export type RenderReply = { ok: true; stale: boolean; marked: number } | { ok: false; error: string };


/** Контекстное меню «Сверка: проверить выделенное» просит панель проверить выделение во вкладке. */
export const CHECK_SELECTION = "vh:check-selection";
export const PENDING_SELECTION_KEY = "pendingSelection";

export interface PendingSelection {
  tabId: number;
  text: string;
  at: number;
}
