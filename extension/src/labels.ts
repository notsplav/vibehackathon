// Подписи статусов для карточки и панели. Цвет — не единственный признак: у каждого статуса есть текст и значок.

import type { ClaimStatus, Verdict } from "../../shared/contract.ts";

export type DisplayState = Verdict | Exclude<ClaimStatus, "checked">;

export const LABELS: Record<DisplayState, { text: string; icon: string }> = {
  supported: { text: "Подтверждается источниками", icon: "✓" },
  contradicted: { text: "Противоречит источникам", icon: "✗" },
  qualified: { text: "Нужна оговорка", icon: "≈" },
  disputed: { text: "Источники расходятся", icon: "⇄" },
  insufficient: { text: "Недостаточно данных", icon: "?" },
  queued: { text: "В очереди", icon: "…" },
  checking: { text: "Проверяется", icon: "…" },
  failed: { text: "Ошибка проверки", icon: "!" },
  not_checked: { text: "Не проверено", icon: "–" },
  opinion: { text: "Мнение, не проверяется", icon: "" },
};

export function displayState(claim: { status: ClaimStatus; verdict: Verdict | null }): DisplayState {
  return claim.status === "checked" && claim.verdict ? claim.verdict : claim.status === "checked" ? "insufficient" : claim.status;
}

/** Итоговое состояние блока с несколькими claims: самое осторожное из имеющихся. */
const BLOCK_PRIORITY: DisplayState[] = [
  "checking",
  "queued",
  "contradicted",
  "disputed",
  "qualified",
  "insufficient",
  "supported",
  "failed",
  "not_checked",
  "opinion",
];

export function blockState(states: DisplayState[]): DisplayState | null {
  for (const s of BLOCK_PRIORITY) if (states.includes(s)) return s === "opinion" ? null : s;
  return null;
}
