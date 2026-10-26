// Сообщения между расширением и помощником «Сверки» (Native Messaging).

import type { Claim, ExtractedArticle, LiveProgress } from "./contract.ts";

export const HOST_NAME = "com.sverka.host";

export interface AnalyzeOptions {
  /** Модель для выделения утверждений (по умолчанию haiku). */
  extractModel?: string;
  /** Модель для проверки с WebSearch (по умолчанию sonnet). */
  checkModel?: string;
  concurrency?: number;
}

export type HostRequest =
  | { type: "ping" }
  | { type: "analyze"; id: string; article: ExtractedArticle; options?: AnalyzeOptions }
  | { type: "cancel"; id: string };

export type HostEvent =
  | { type: "pong"; version: number; claudeBin: string; claudeFound: boolean; defaults: { extractModel: string; checkModel: string; concurrency: number } }
  | { type: "stage"; id: string; status: "extracting_claims" | "checking" | "completed" | "failed" | "cancelled"; error?: string | null }
  | { type: "claims"; id: string; claims: Claim[] }
  | { type: "claim"; id: string; claim: Claim }
  | { type: "live"; id: string; live: LiveProgress }
  | { type: "summary"; id: string; summary: string }
  | { type: "cost"; id: string; usd: number };
