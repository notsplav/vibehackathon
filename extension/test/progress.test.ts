import { describe, expect, test } from "vitest";
import type { AnalysisState, Claim } from "../../shared/contract.ts";
import { estimateRemainingMs, renderProgress, stages, tick } from "../src/sidepanel/progress.ts";

const claim = (id: string, patch: Partial<Claim> = {}): Claim => ({
  id, blockIds: ["b1"], exactText: "x", occurrences: [{ blockId: "b1", exactText: "x" }], normalizedClaim: `Утверждение ${id}`,
  kind: "other", status: "queued", verdict: null, explanation: null, evidence: [], ...patch,
});

function state(patch: Partial<AnalysisState>): AnalysisState {
  const claims = patch.claims ?? [];
  return {
    analysisId: "a", status: "checking", focus: null, preliminary: true, url: "https://example.test/", canonicalUrl: null,
    metadata: { title: "T", subtitle: null, authors: [], publishedAt: null, modifiedAt: null }, claims,
    stats: { total: 4, completed: 2, notCompleted: 2, byVerdict: { supported: 1, contradicted: 0, qualified: 0, disputed: 0, insufficient: 1 }, failed: 0, notChecked: 0, opinions: 1 },
    summary: null, error: null, live: null, createdAt: "2026-10-25T12:00:00Z", updatedAt: "2026-10-25T12:01:00Z", ...patch,
  };
}

describe("этапы анализа", () => {
  test("выделение утверждений: активен второй шаг, видна часть статьи", () => {
    const st = stages(state({ status: "extracting_claims", live: { extraction: { done: 1, total: 3 }, checking: [] } }));
    expect(st.map((s) => s.state)).toEqual(["done", "active", "pending", "pending"]);
    expect(st[1]!.detail).toBe("часть 2 из 3");
  });

  test("проверка: активен третий шаг с числом проверенных", () => {
    const st = stages(state({ live: { extraction: null, checking: [] } }));
    expect(st.map((s) => s.state)).toEqual(["done", "done", "active", "pending"]);
    expect(st[1]!.detail).toBe("найдено 4, мнений 1");
    expect(st[2]!.detail).toBe("2 из 4");
  });

  test("остановка по ошибке квоты и отмена отмечаются отдельно", () => {
    expect(stages(state({ status: "completed", error: "Квота", live: null }))[2]!.state).toBe("error");
    expect(stages(state({ status: "cancelled", live: null }))[2]!.detail).toMatch(/отменена/);
  });
});

test("оценка оставшегося времени по интервалам между проверками", () => {
  const a = state({
    claims: [
      claim("c1", { status: "checked", verdict: "supported", checkedAt: "2026-10-25T12:00:00Z" }),
      claim("c2", { status: "checked", verdict: "insufficient", checkedAt: "2026-10-25T12:00:30Z" }),
      claim("c3", { status: "checking" }),
      claim("c4"),
    ],
    live: { extraction: null, checking: [{ claimId: "c3", step: "search", since: "2026-10-25T12:00:30Z", queries: [] }] },
  });
  // 30 с на утверждение × 2 оставшихся − 10 с уже идущей проверки.
  expect(estimateRemainingMs(a, Date.parse("2026-10-25T12:00:40Z"))).toBe(50_000);
});

test("панель показывает текущее действие, запросы и тикающий таймер", () => {
  const a = state({
    claims: [claim("c3", { status: "checking" })],
    live: { extraction: null, checking: [{ claimId: "c3", step: "search", since: new Date(Date.now() - 5000).toISOString(), queries: ["Кюри 1867"] }] },
  });
  const el = renderProgress(a, Date.now());
  expect(el.querySelector(".now")!.textContent).toContain("«Утверждение c3»");
  expect(el.querySelector(".now")!.textContent).toContain("ищем источники");
  expect(el.querySelector(".now-queries")!.textContent).toBe("Запросы: «Кюри 1867»");
  expect(el.querySelectorAll(".spinner").length).toBeGreaterThan(0);
  expect(el.querySelector(".status-pill")!.textContent).toMatch(/^Анализ идёт · (\d+ с|\d+:\d\d)$/);
  expect(el.textContent).not.toContain("Предварительный результат");
  tick(el, Date.now() + 60_000);
  expect(el.querySelector(".now .timer")!.textContent).toMatch(/^1:0\d$/);
});
