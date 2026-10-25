// Маркеры на исходной странице. Структура статьи не меняется: только data-атрибуты на блоках
// и одна таблица стилей. Ссылки и выделение текста продолжают работать.

import type { Claim } from "../../../shared/contract.ts";
import { type DisplayState, LABELS, blockState, displayState } from "../labels.ts";
import { HIGHLIGHT_CSS } from "./highlight.ts";

export const STATUS_ATTR = "data-vh-status";
const ICON_ATTR = "data-vh-icon";
const STYLE_ID = "vh-factcheck-style";

const COLORS: Record<DisplayState, string> = {
  supported: "#1a7f37",
  contradicted: "#cf222e",
  qualified: "#bf8700",
  disputed: "#8250df",
  insufficient: "#57606a",
  queued: "#8c959f",
  checking: "#8c959f",
  failed: "#8c959f",
  not_checked: "#afb8c1",
  opinion: "transparent",
};

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  const rules = (Object.keys(COLORS) as DisplayState[])
    .filter((s) => s !== "opinion")
    .map(
      (s) =>
        `[${STATUS_ATTR}="${s}"]{box-shadow:inset 3px 0 0 ${COLORS[s]};background-color:color-mix(in srgb, ${COLORS[s]} 7%, transparent)}` +
        `[${STATUS_ATTR}="${s}"]::after{color:${COLORS[s]}}`,
    )
    .join("");
  style.textContent =
    `[${STATUS_ATTR}]{cursor:pointer;padding-left:6px;transition:background-color .2s}` +
    `[${STATUS_ATTR}="checking"],[${STATUS_ATTR}="queued"]{box-shadow:inset 3px 0 0 #8c959f}` +
    // Блок, который проверяется прямо сейчас, мягко пульсирует (без движения при prefers-reduced-motion).
    `@keyframes vh-pulse{50%{background-color:color-mix(in srgb, #0969da 14%, transparent)}}` +
    `[${STATUS_ATTR}="checking"]{animation:vh-pulse 1.6s ease-in-out infinite}` +
    `@media (prefers-reduced-motion: reduce){[${STATUS_ATTR}="checking"]{animation:none}}` +
    `[${STATUS_ATTR}="failed"]{box-shadow:inset 3px 0 0 #8c959f;outline:1px dashed #8c959f;outline-offset:2px}` +
    `[${STATUS_ATTR}]::after{content:attr(${ICON_ATTR});font:600 13px/1 system-ui,sans-serif;margin-left:.35em;vertical-align:super}` +
    rules +
    HIGHLIGHT_CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Claims, относящиеся к блоку (с учётом объединённых дубликатов). */
export function claimsByBlock(claims: Claim[]): Map<string, Claim[]> {
  const map = new Map<string, Claim[]>();
  for (const c of claims) {
    for (const id of new Set(c.occurrences.map((o) => o.blockId))) {
      const list = map.get(id) ?? [];
      list.push(c);
      map.set(id, list);
    }
  }
  return map;
}

export function applyMarkers(elements: Map<string, Element>, claims: Claim[]): number {
  const first = elements.values().next().value as Element | undefined;
  if (!first) return 0;
  ensureStyle(first.ownerDocument);
  const byBlock = claimsByBlock(claims);
  let marked = 0;
  for (const [blockId, el] of elements) {
    const list = byBlock.get(blockId) ?? [];
    const state = blockState(list.map(displayState));
    if (!state) {
      el.removeAttribute(STATUS_ATTR);
      el.removeAttribute(ICON_ATTR);
      continue;
    }
    el.setAttribute(STATUS_ATTR, state);
    const checkable = list.filter((c) => c.status !== "opinion").length;
    el.setAttribute(ICON_ATTR, `${LABELS[state].icon}${checkable > 1 ? ` ${checkable}` : ""}`);
    marked++;
  }
  return marked;
}

export function clearMarkers(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`[${STATUS_ATTR}]`))) {
    el.removeAttribute(STATUS_ATTR);
    el.removeAttribute(ICON_ATTR);
  }
  doc.getElementById(STYLE_ID)?.remove();
}
