// Очередь анализа: этап A (claims), этап B (проверка с ограниченным параллелизмом), этап C (сводка).
// Всё состояние — в SQLite, поэтому панель может переподключиться по analysisId в любой момент.

import type { Store } from "../db/store.ts";
import { now } from "../db/store.ts";
import { ModelError, type ModelErrorKind, type Provider, classifyError, userMessage } from "../llm/errors.ts";
import type { FactChecker } from "../llm/types.ts";
import { checkableBlocks, chunkBlocks, mergeDuplicates, validateClaims } from "./claims.ts";
import { decideVerdict } from "./evidence.ts";
import { computeStats } from "./stats.ts";

/** Версия алгоритма: входит в ключ кэша, чтобы после изменения промптов не показывать старые результаты. */
export const ALGORITHM_VERSION = 1;

/**
 * Сколько подряд claims могут упасть с одной и той же повторяемой ошибкой (429, недоступность) после всех
 * повторов, прежде чем проверки останавливаются: для 429 это значит, что квота исчерпана.
 */
const MAX_CONSECUTIVE_RETRYABLE = 2;

export interface RunnerOptions {
  provider: Provider;
  concurrency: number;
  chunkChars: number;
  /** Секрет, который вырезается из сообщений об ошибках. */
  apiKey: string | null;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

interface RunState {
  controller: AbortController;
  cancelled: boolean;
}

export class AnalysisRunner {
  private readonly running = new Map<string, RunState>();
  private readonly store: Store;
  private readonly checker: FactChecker | null;
  private readonly options: RunnerOptions;
  private readonly log: Logger;

  constructor(
    store: Store,
    checker: FactChecker | null,
    options: RunnerOptions,
    log: Logger,
  ) {
    this.store = store;
    this.checker = checker;
    this.options = options;
    this.log = log;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  start(id: string): void {
    if (this.running.has(id)) return;
    const state: RunState = { controller: new AbortController(), cancelled: false };
    this.running.set(id, state);
    this.run(id, state)
      .catch((e) => {
        // Анализ мог быть удалён во время работы — тогда писать уже некуда.
        if (!this.store.getAnalysisRow(id)) return;
        const err = classifyError(e, this.options.apiKey);
        this.log.warn(`analysis ${id} failed: ${err.kind}`);
        this.store.moveClaims(id, ["queued", "checking"], "failed", this.message(err.kind));
        this.store.setStatus(id, "failed", this.message(err.kind));
      })
      .finally(() => this.running.delete(id));
  }

  /** Останавливает ещё не начатые проверки; уже готовые результаты сохраняются. */
  cancel(id: string): boolean {
    const row = this.store.getAnalysisRow(id);
    if (!row) return false;
    if (row.status === "completed" || row.status === "failed") return true;
    const state = this.running.get(id);
    if (state) state.cancelled = true;
    this.store.moveClaims(id, ["queued"], "not_checked", "Проверка отменена пользователем");
    this.store.setStatus(id, "cancelled");
    return true;
  }

  /** Удаление прерывает и текущие запросы к Gemini. */
  abort(id: string): void {
    const state = this.running.get(id);
    if (state) {
      state.cancelled = true;
      state.controller.abort(new Error("analysis deleted"));
    }
  }

  /** После перезапуска сервера: прерванные проверки возвращаются в очередь и продолжаются. */
  resumeAll(): void {
    for (const id of this.store.unfinishedIds()) {
      const moved = this.store.moveClaims(id, ["checking"], "queued");
      this.log.info(`resume analysis ${id} (${moved} claims requeued)`);
      this.start(id);
    }
  }

  private message(kind: ModelErrorKind): string {
    return userMessage(kind, this.options.provider);
  }

  private async run(id: string, state: RunState): Promise<void> {
    const signal = state.controller.signal;
    if (!this.checker) {
      this.store.setStatus(id, "failed", this.message("not_configured"));
      return;
    }
    const row = this.store.getAnalysisRow(id);
    if (!row) return;
    const article = { title: row.metadata.title, publishedAt: row.metadata.publishedAt?.value ?? null, url: row.canonicalUrl ?? row.url };
    const blocks = this.store.getBlocks(id);

    // --- Этап A ---
    if (this.store.getClaims(id).length === 0) {
      this.store.setStatus(id, "extracting_claims");
      const raw = [];
      for (const chunk of chunkBlocks(checkableBlocks(blocks), this.options.chunkChars)) {
        raw.push(...(await this.checker.extractClaims(article, chunk, signal)));
        if (state.cancelled) break;
      }
      const report = validateClaims(raw, blocks);
      if (report.rejected || report.droppedOccurrences || report.reassignedOccurrences) {
        this.log.warn(
          `analysis ${id}: rejected ${report.rejected} claims, dropped ${report.droppedOccurrences} and reassigned ${report.reassignedOccurrences} occurrences`,
        );
      }
      const merged = mergeDuplicates(report.claims, blocks);
      this.store.insertClaims(
        id,
        merged.map((c, i) => ({
          id: `c${i + 1}`,
          normalizedClaim: c.normalizedClaim,
          occurrences: c.occurrences,
          kind: c.kind,
          status: c.isOpinion ? "opinion" : state.cancelled ? "not_checked" : "queued",
        })),
      );
      if (state.cancelled) return;
    }

    // --- Этап B ---
    this.store.setStatus(id, "checking");
    const queue = this.store.claimIdsWithStatus(id, "queued");
    const blockText = new Map(blocks.map((b) => [b.id, b.text]));
    const claims = new Map(this.store.getClaims(id).map((c) => [c.id, c]));
    let lastRetryable: { kind: ModelErrorKind; count: number } | null = null;
    let fatal: string | null = null;

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !state.cancelled && !fatal) {
        const claimId = queue.shift()!;
        const claim = claims.get(claimId);
        if (!claim) continue;
        this.store.updateClaim(id, claimId, { status: "checking" });
        try {
          const outcome = await this.checker!.checkClaim(
            {
              claim: claim.normalizedClaim,
              kind: claim.kind,
              context: [...new Set(claim.occurrences.map((o) => blockText.get(o.blockId) ?? o.exactText))],
              article,
            },
            signal,
          );
          const decision = decideVerdict({
            verdict: outcome.verdict,
            explanation: outcome.explanation,
            sources: outcome.sources,
            citations: outcome.citations,
            interactionId: outcome.interactionId,
            retrievedAt: now(),
            articleUrl: article.url,
          });
          if (decision.downgraded) this.log.info(`claim ${id}/${claimId}: ${decision.downgraded}`);
          this.store.replaceEvidence(id, claimId, decision.evidence);
          this.store.updateClaim(id, claimId, {
            status: "checked",
            verdict: decision.verdict,
            explanation: decision.downgraded ? `${decision.explanation} (Нет ссылок из поиска, подтверждающих вывод.)` : decision.explanation,
            error: null,
            checkedAt: now(),
          });
          lastRetryable = null;
        } catch (e) {
          if (signal.aborted) return;
          const err = e instanceof ModelError ? e : classifyError(e, this.options.apiKey);
          this.store.updateClaim(id, claimId, { status: "failed", error: this.message(err.kind), checkedAt: now() });
          if (err.fatal) fatal = this.message(err.kind);
          else if (err.retryable) {
            lastRetryable = lastRetryable?.kind === err.kind ? { kind: err.kind, count: lastRetryable.count + 1 } : { kind: err.kind, count: 1 };
            if (lastRetryable.count >= MAX_CONSECUTIVE_RETRYABLE) {
              fatal = this.message(err.kind === "rate_limited" ? "quota_exhausted" : err.kind);
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: this.options.concurrency }, worker));
    if (signal.aborted || state.cancelled) return;

    if (fatal) {
      // Остальные проверки не запускаем: результат был бы тем же, а квота тратилась бы впустую.
      this.store.moveClaims(id, ["queued"], "failed", fatal);
      this.store.setStatus(id, "completed", fatal);
    } else {
      this.store.setStatus(id, "completed");
    }

    // --- Этап C ---
    const finalClaims = this.store.getClaims(id);
    if (fatal || finalClaims.every((c) => c.status !== "checked")) return;
    try {
      const summary = await this.checker.summarize(
        {
          stats: computeStats(finalClaims),
          preliminary: false,
          claims: finalClaims.map((c) => ({ claim: c.normalizedClaim, verdict: c.verdict, status: c.status, explanation: c.explanation })),
        },
        signal,
      );
      this.store.setSummary(id, summary);
    } catch (e) {
      this.log.warn(`analysis ${id}: summary failed (${classifyError(e, this.options.apiKey).kind})`);
    }
  }
}
