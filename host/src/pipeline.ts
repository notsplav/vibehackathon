// Проверка статьи через Claude Code: выделение утверждений (быстрая модель без инструментов),
// параллельная проверка каждого утверждения с WebSearch и короткая сводка. Результаты уходят
// в расширение по мере готовности; хранит их расширение.

import type { ArticleFocus, Claim, ClaimStatus, ExtractedArticle, LiveProgress } from "../../shared/contract.ts";
import type { HostEvent } from "../../shared/host.ts";

export type { HostEvent };
import { checkableBlocks, mergeDuplicates, restrictToFocus, sentencesAround, validateClaims, type RawClaim } from "../../core/claims.ts";
import { type Citation, decideVerdict } from "../../core/evidence.ts";
import { CHECK_RETRY_PREFIX, CHECK_SCHEMA, CHECK_SYSTEM, EXTRACT_SCHEMA, EXTRACT_SYSTEM, SUMMARY_SYSTEM, checkInput, extractInput, extractSystem } from "../../core/prompts.ts";
import { computeStats } from "../../core/stats.ts";
import { ClaudeError, type ClaudeOptions, type ClaudeResult, runClaude } from "./claude.ts";

export interface AnalyzeOptions {
  claudeBin: string;
  /** Выделение утверждений: быстрая модель без инструментов. */
  extractModel: string;
  /** Проверка с WebSearch. */
  checkModel: string;
  concurrency: number;
  /** Потолок трат на один вызов claude, $. */
  maxBudgetPerCall: number;
}

export const DEFAULT_OPTIONS: Omit<AnalyzeOptions, "claudeBin"> = {
  extractModel: "haiku",
  checkModel: "sonnet",
  concurrency: 5,
  maxBudgetPerCall: 0.5,
};

export type ClaudeRunner = (o: ClaudeOptions) => Promise<ClaudeResult>;

/** URL без завершающего слэша и фрагмента — для сопоставления ссылок модели с результатами поиска. */
function urlKey(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    return u.href.replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Ответ этапа проверки → вердикт по общему правилу: ссылки только из результатов WebSearch. */
export function verdictFromCheck(claim: Claim, result: ClaudeResult, articleUrl: string, now: string): Claim {
  const out = (result.structured ?? {}) as { verdict?: unknown; explanation?: unknown; sources?: { url?: unknown; role?: unknown; relation?: unknown }[] };
  const citations: Citation[] = result.searchHits.map((h, i) => ({ url: h.url, title: h.title, annotationIndex: i, citedText: null }));
  const byUrl = new Map(citations.map((c, i) => [urlKey(c.url), i + 1]));
  const sources = (Array.isArray(out.sources) ? out.sources : [])
    .map((s) => ({ index: typeof s?.url === "string" ? (byUrl.get(urlKey(s.url)) ?? -1) : -1, role: s?.role, relation: s?.relation }))
    .filter((s) => s.index > 0);
  const verdict = ["supported", "contradicted", "qualified", "disputed", "insufficient"].includes(out.verdict as string) ? (out.verdict as Claim["verdict"]) : "insufficient";
  const decision = decideVerdict({
    verdict: verdict!,
    explanation: typeof out.explanation === "string" ? out.explanation.trim().slice(0, 1500) : "",
    sources,
    citations,
    interactionId: null,
    retrievedAt: now,
    articleUrl,
  });
  return {
    ...claim,
    status: "checked",
    verdict: decision.verdict,
    explanation: decision.downgraded ? `${decision.explanation} (Нет ссылок из поиска, подтверждающих вывод.)` : decision.explanation,
    evidence: decision.evidence,
    error: null,
    checkedAt: now,
  };
}

export async function analyze(
  id: string,
  article: ExtractedArticle,
  options: AnalyzeOptions,
  emit: (e: HostEvent) => void,
  signal: AbortSignal,
  run: ClaudeRunner = runClaude,
): Promise<void> {
  const focus: ArticleFocus | null = article.focus ?? null;
  const meta = { title: article.metadata.title, publishedAt: article.metadata.publishedAt?.value ?? null, url: article.canonicalUrl ?? article.url };
  const live: LiveProgress = { extraction: { done: 0, total: 1 }, checking: [] };
  let cost = 0;
  const spend = (r: ClaudeResult) => {
    cost += r.costUsd;
    emit({ type: "cost", id, usd: cost });
  };

  // --- Этап A: утверждения ---
  emit({ type: "stage", id, status: "extracting_claims" });
  emit({ type: "live", id, live });
  const blocks = checkableBlocks(article.blocks);
  let extraction: ClaudeResult;
  try {
    extraction = await run({
      bin: options.claudeBin,
      prompt: extractInput(meta, blocks, focus),
      systemPrompt: extractSystem(EXTRACT_SYSTEM, focus),
      model: options.extractModel,
      tools: [],
      jsonSchema: EXTRACT_SCHEMA,
      maxTurns: 3,
      maxBudgetUsd: options.maxBudgetPerCall,
      signal,
    });
  } catch (e) {
    // Отмена во время выделения утверждений — это отмена, а не ошибка.
    if (signal.aborted) {
      emit({ type: "stage", id, status: "cancelled" });
      return;
    }
    throw e;
  }
  spend(extraction);
  const raw = ((extraction.structured as { claims?: unknown })?.claims ?? []) as RawClaim[];
  const focusIds = focus ? new Set(focus.blockIds) : null;
  const report = validateClaims(Array.isArray(raw) ? raw : [], focusIds ? blocks.filter((b) => focusIds.has(b.id)) : blocks);
  const drafts = mergeDuplicates(focus ? restrictToFocus(report.claims, focus) : report.claims, article.blocks);
  let claims: Claim[] = drafts.map((d, i) => ({
    id: `c${i + 1}`,
    blockIds: [...new Set(d.occurrences.map((o) => o.blockId))],
    exactText: d.occurrences[0]!.exactText,
    occurrences: d.occurrences,
    normalizedClaim: d.normalizedClaim,
    kind: d.kind,
    status: (d.isOpinion ? "opinion" : "queued") as ClaimStatus,
    verdict: null,
    explanation: null,
    evidence: [],
  }));
  live.extraction = { done: 1, total: 1 };
  emit({ type: "claims", id, claims });

  // --- Этап B: проверка, параллельно ---
  emit({ type: "stage", id, status: "checking" });
  const blockText = new Map(article.blocks.map((b) => [b.id, b.text]));
  const queue = claims.filter((c) => c.status === "queued").map((c) => c.id);
  let fatal: string | null = null;
  const update = (claim: Claim) => {
    claims = claims.map((c) => (c.id === claim.id ? claim : c));
    emit({ type: "claim", id, claim });
  };

  const worker = async (): Promise<void> => {
    while (queue.length && !fatal && !signal.aborted) {
      const claimId = queue.shift()!;
      const claim = claims.find((c) => c.id === claimId)!;
      const entry: LiveProgress["checking"][number] = { claimId, step: "search", since: new Date().toISOString(), queries: [] };
      live.checking.push(entry);
      update({ ...claim, status: "checking" });
      emit({ type: "live", id, live });
      try {
        const context = [...new Set(claim.occurrences.map((o) => sentencesAround(blockText.get(o.blockId) ?? o.exactText, o.exactText)))];
        const input = checkInput(claim, context, meta);
        const check = (prompt: string) =>
          run({
            bin: options.claudeBin,
            prompt,
            systemPrompt: CHECK_SYSTEM,
            model: options.checkModel,
            tools: ["WebSearch"],
            jsonSchema: CHECK_SCHEMA,
            // Ходов ≈ поисков + 2: правила просят не больше 3 поисков, предел 6 ходов страхует от перебора.
            maxTurns: 6,
            maxBudgetUsd: options.maxBudgetPerCall,
            signal,
            onSearch: (q) => {
              entry.queries = [...entry.queries, q].slice(-5);
              emit({ type: "live", id, live });
            },
          });
        let result = await check(input);
        spend(result);
        // Модель иногда отвечает по памяти без поиска — такой ответ не принимается, просим ещё раз один раз.
        if (result.searchQueries.length === 0) {
          result = await check(CHECK_RETRY_PREFIX + input);
          spend(result);
        }
        update(verdictFromCheck(claim, result, meta.url, new Date().toISOString()));
      } catch (e) {
        if (signal.aborted) return;
        const err = e instanceof ClaudeError ? e : new ClaudeError("failed", String(e));
        update({ ...claim, status: "failed", error: err.message, checkedAt: new Date().toISOString() });
        if (err.fatal) fatal = err.message;
      } finally {
        live.checking = live.checking.filter((c) => c !== entry);
        emit({ type: "live", id, live });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

  if (signal.aborted) {
    for (const c of claims) if (c.status === "queued" || c.status === "checking") update({ ...c, status: "not_checked", error: "Проверка отменена" });
    emit({ type: "stage", id, status: "cancelled" });
    return;
  }
  if (fatal) {
    for (const c of claims) if (c.status === "queued") update({ ...c, status: "failed", error: fatal });
    emit({ type: "stage", id, status: "completed", error: fatal });
    return;
  }

  // --- Этап C: сводка (быстрая модель, по уже сохранённым результатам) ---
  if (claims.some((c) => c.status === "checked")) {
    try {
      const summary = await run({
        bin: options.claudeBin,
        prompt: JSON.stringify({ stats: computeStats(claims), claims: claims.map((c) => ({ claim: c.normalizedClaim, status: c.status, verdict: c.verdict, explanation: c.explanation })) }),
        systemPrompt: SUMMARY_SYSTEM,
        model: options.extractModel,
        tools: [],
        maxTurns: 1,
        maxBudgetUsd: options.maxBudgetPerCall,
        signal,
      });
      spend(summary);
      if (summary.text.trim()) emit({ type: "summary", id, summary: summary.text.trim().slice(0, 1200) });
    } catch {
      // Сводка необязательна: без неё результат проверки остаётся полным.
    }
  }
  emit({ type: "stage", id, status: "completed" });
}
