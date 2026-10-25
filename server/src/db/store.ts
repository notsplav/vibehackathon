// Хранилище анализов в SQLite (встроенный node:sqlite). Все запросы параметризованы.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AnalysisState,
  AnalysisStatus,
  ArticleMetadata,
  Block,
  Claim,
  ClaimKind,
  ClaimOccurrence,
  ClaimStatus,
  Evidence,
  Verdict,
} from "../../../shared/contract.ts";
import { normalizeForMatch } from "../../../shared/text.ts";
import { computeStats } from "../pipeline/stats.ts";
import { MIGRATIONS } from "./migrations.ts";

export interface AnalysisRow {
  id: string;
  /** Запущен через «Повторить анализ»: готовые результаты других анализов не переиспользуются. */
  fresh: boolean;
  url: string;
  canonicalUrl: string | null;
  status: AnalysisStatus;
  metadata: ArticleMetadata;
  error: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ClaimPatch = Partial<Pick<Claim, "status" | "verdict" | "explanation" | "error" | "checkedAt">> & { attempts?: number };

const TERMINAL: AnalysisStatus[] = ["completed", "cancelled", "failed"];

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, now());
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  createAnalysis(input: {
    id: string;
    url: string;
    canonicalUrl: string | null;
    cacheUrl: string;
    textHash: string;
    algorithmVersion: number;
    /** Провайдер и модель, например "ollama:qwen3:14b". */
    engine: string;
    fresh?: boolean;
    metadata: ArticleMetadata;
    blocks: Block[];
  }): void {
    const ts = now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO analyses (id, url, canonical_url, cache_url, text_hash, algorithm_version, engine, fresh, status, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(input.id, input.url, input.canonicalUrl, input.cacheUrl, input.textHash, input.algorithmVersion, input.engine, input.fresh ? 1 : 0, JSON.stringify(input.metadata), ts, ts);
      const insert = this.db.prepare("INSERT INTO blocks (analysis_id, block_id, ord, type, text, links_json) VALUES (?, ?, ?, ?, ?, ?)");
      for (const b of input.blocks) insert.run(input.id, b.id, b.order, b.type, b.text, JSON.stringify(b.links));
    });
  }

  /**
   * Последний анализ той же редакции статьи той же моделью. Отменённые, упавшие и завершённые
   * с общей ошибкой (например, исчерпана квота) не переиспользуются.
   */
  findCached(cacheUrl: string, textHash: string, algorithmVersion: number, engine: string): AnalysisRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM analyses WHERE cache_url = ? AND text_hash = ? AND algorithm_version = ? AND engine = ?
           AND status NOT IN ('cancelled', 'failed') AND error IS NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get(cacheUrl, textHash, algorithmVersion, engine) as Record<string, unknown> | undefined;
    return row ? toAnalysisRow(row) : null;
  }

  getAnalysisRow(id: string): AnalysisRow | null {
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toAnalysisRow(row) : null;
  }

  getState(id: string): AnalysisState | null {
    const row = this.getAnalysisRow(id);
    if (!row) return null;
    const claims = this.getClaims(id);
    return {
      analysisId: row.id,
      status: row.status,
      preliminary: !TERMINAL.includes(row.status) || claims.some((c) => c.status === "queued" || c.status === "checking"),
      url: row.url,
      canonicalUrl: row.canonicalUrl,
      metadata: row.metadata,
      claims,
      stats: computeStats(claims),
      summary: row.summary,
      error: row.error,
      live: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  getBlocks(id: string): Block[] {
    const rows = this.db.prepare("SELECT * FROM blocks WHERE analysis_id = ? ORDER BY ord").all(id) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.block_id),
      type: r.type as Block["type"],
      order: Number(r.ord),
      text: String(r.text),
      links: JSON.parse(String(r.links_json)),
    }));
  }

  getClaims(id: string): Claim[] {
    const rows = this.db.prepare("SELECT * FROM claims WHERE analysis_id = ? ORDER BY ord").all(id) as Record<string, unknown>[];
    const evidenceRows = this.db.prepare("SELECT * FROM evidence WHERE analysis_id = ? ORDER BY claim_id, idx").all(id) as Record<string, unknown>[];
    const evidence = new Map<string, Evidence[]>();
    for (const e of evidenceRows) {
      const list = evidence.get(String(e.claim_id)) ?? [];
      list.push({
        url: String(e.url),
        title: (e.title as string | null) ?? null,
        retrievedAt: String(e.retrieved_at),
        role: e.role as Evidence["role"],
        relation: (e.relation as string | null) ?? null,
        grounding: { interactionId: (e.interaction_id as string | null) ?? null, annotationIndex: Number(e.annotation_index) },
      });
      evidence.set(String(e.claim_id), list);
    }
    return rows.map((r) => {
      const occurrences = JSON.parse(String(r.occurrences_json)) as ClaimOccurrence[];
      return {
        id: String(r.claim_id),
        blockIds: [...new Set(occurrences.map((o) => o.blockId))],
        exactText: String(r.exact_text),
        occurrences,
        normalizedClaim: String(r.normalized_claim),
        kind: r.kind as ClaimKind,
        status: r.status as ClaimStatus,
        verdict: (r.verdict as Verdict | null) ?? null,
        explanation: (r.explanation as string | null) ?? null,
        evidence: evidence.get(String(r.claim_id)) ?? [],
        error: (r.error as string | null) ?? null,
        checkedAt: (r.checked_at as string | null) ?? null,
      };
    });
  }

  setStatus(id: string, status: AnalysisStatus, error: string | null = null): void {
    this.db.prepare("UPDATE analyses SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), id);
  }

  setSummary(id: string, summary: string | null): void {
    this.db.prepare("UPDATE analyses SET summary = ?, updated_at = ? WHERE id = ?").run(summary, now(), id);
  }

  insertClaims(id: string, claims: Pick<Claim, "id" | "normalizedClaim" | "occurrences" | "kind" | "status">[]): void {
    this.tx(() => {
      const insert = this.db.prepare(
        `INSERT INTO claims (analysis_id, claim_id, ord, normalized_claim, exact_text, occurrences_json, kind, status, claim_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      claims.forEach((c, i) =>
        insert.run(id, c.id, i + 1, c.normalizedClaim, c.occurrences[0]!.exactText, JSON.stringify(c.occurrences), c.kind, c.status, claimKey(c)),
      );
      this.touch(id);
    });
  }

  updateClaim(id: string, claimId: string, patch: ClaimPatch): void {
    const columns: Record<keyof ClaimPatch, string> = {
      status: "status",
      verdict: "verdict",
      explanation: "explanation",
      error: "error",
      checkedAt: "checked_at",
      attempts: "attempts",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof ClaimPatch, unknown][];
    if (entries.length === 0) return;
    const set = entries.map(([k]) => `${columns[k]} = ?`).join(", ");
    this.db
      .prepare(`UPDATE claims SET ${set} WHERE analysis_id = ? AND claim_id = ?`)
      .run(...(entries.map(([, v]) => v) as (string | number | null)[]), id, claimId);
    this.touch(id);
  }

  replaceEvidence(id: string, claimId: string, evidence: Evidence[]): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM evidence WHERE analysis_id = ? AND claim_id = ?").run(id, claimId);
      const insert = this.db.prepare(
        `INSERT INTO evidence (analysis_id, claim_id, idx, url, title, retrieved_at, role, relation, interaction_id, annotation_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      evidence.forEach((e, i) =>
        insert.run(id, claimId, i, e.url, e.title, e.retrievedAt, e.role, e.relation, e.grounding.interactionId, e.grounding.annotationIndex),
      );
    });
  }

  /** Переводит claims из одних статусов в другой (например, queued → not_checked при отмене). */
  moveClaims(id: string, from: ClaimStatus[], to: ClaimStatus, error: string | null = null): number {
    const placeholders = from.map(() => "?").join(", ");
    const res = this.db
      .prepare(`UPDATE claims SET status = ?, error = COALESCE(?, error) WHERE analysis_id = ? AND status IN (${placeholders})`)
      .run(to, error, id, ...from);
    this.touch(id);
    return Number(res.changes);
  }

  claimIdsWithStatus(id: string, status: ClaimStatus): string[] {
    return (this.db.prepare("SELECT claim_id FROM claims WHERE analysis_id = ? AND status = ? ORDER BY ord").all(id, status) as { claim_id: string }[]).map(
      (r) => r.claim_id,
    );
  }

  /**
   * Последняя успешная проверка такого же утверждения той же моделью не старше `since` в другом анализе.
   * Возвращает вердикт, объяснение и свидетельства для копирования.
   */
  findReusableClaim(
    claim: Pick<Claim, "normalizedClaim" | "kind">,
    engine: string,
    since: string,
    excludeAnalysisId: string,
  ): Pick<Claim, "verdict" | "explanation" | "evidence" | "checkedAt"> | null {
    const row = this.db
      .prepare(
        `SELECT c.analysis_id, c.claim_id, c.verdict, c.explanation, c.checked_at FROM claims c JOIN analyses a ON a.id = c.analysis_id
          WHERE c.claim_key = ? AND c.status = 'checked' AND c.verdict IS NOT NULL AND c.checked_at >= ?
            AND a.engine = ? AND c.analysis_id <> ?
          ORDER BY c.checked_at DESC LIMIT 1`,
      )
      .get(claimKey(claim), since, engine, excludeAnalysisId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const source = this.getClaims(String(row.analysis_id)).find((c) => c.id === String(row.claim_id));
    if (!source) return null;
    return { verdict: source.verdict, explanation: source.explanation, evidence: source.evidence, checkedAt: source.checkedAt ?? null };
  }

  engineOf(id: string): string | null {
    const row = this.db.prepare("SELECT engine FROM analyses WHERE id = ?").get(id) as { engine: string } | undefined;
    return row?.engine ?? null;
  }

  /** Анализы, прерванные остановкой сервера. */
  unfinishedIds(): string[] {
    return (this.db.prepare("SELECT id FROM analyses WHERE status IN ('queued', 'extracting_claims', 'checking')").all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  deleteAnalysis(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM analyses WHERE id = ?").run(id).changes) > 0;
  }

  private touch(id: string): void {
    this.db.prepare("UPDATE analyses SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  close(): void {
    this.db.close();
  }
}

/** Ключ одинаковых утверждений: вид и нормализованная формулировка. */
function claimKey(c: Pick<Claim, "normalizedClaim" | "kind">): string {
  return `${c.kind}:${normalizeForMatch(c.normalizedClaim)}`;
}

function toAnalysisRow(r: Record<string, unknown>): AnalysisRow {
  return {
    id: String(r.id),
    fresh: Number(r.fresh) === 1,
    url: String(r.url),
    canonicalUrl: (r.canonical_url as string | null) ?? null,
    status: r.status as AnalysisStatus,
    metadata: JSON.parse(String(r.metadata_json)),
    error: (r.error as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function now(): string {
  return new Date().toISOString();
}
