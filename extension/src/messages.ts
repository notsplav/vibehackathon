// Сообщения между боковой панелью и content script.

import type { Claim, ExtractedArticle } from "../../shared/contract.ts";

export type PanelMessage =
  | { type: "vh:extract" }
  | { type: "vh:render"; claims: Claim[]; fingerprint: string }
  | { type: "vh:focus"; blockId: string }
  | { type: "vh:clear" };

export type ExtractReply = { ok: true; article: ExtractedArticle; fingerprint: string } | { ok: false; error: string };
export type RenderReply = { ok: true; stale: boolean; marked: number } | { ok: false; error: string };

export const SERVER_URL = "http://127.0.0.1:8787";
