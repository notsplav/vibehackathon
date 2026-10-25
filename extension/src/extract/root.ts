// Поиск корневого контейнера основного текста на живой странице (ТЗ 5.2).

import { isInExcludedRegion } from "./regions.ts";
import { isHiddenDeep, linkDensity, visibleText } from "./text.ts";

export const MIN_BODY_CHARS = 250;
export const MAX_LINK_DENSITY = 0.5;

export interface RootCandidate {
  root: Element;
  method: "jsonld.fragment" | "itemprop.articleBody" | "dom.score" | "readability";
}

function usable(el: Element | null): el is Element {
  return !!el && !isHiddenDeep(el) && !isInExcludedRegion(el);
}

/** Достаточно ли в контейнере связного текста, а не ссылок. */
export function validateRoot(root: Element): { ok: boolean; chars: number; linkDensity: number } {
  let chars = 0;
  for (const p of Array.from(root.querySelectorAll("p, li, blockquote, h2, h3"))) {
    if (!isHiddenDeep(p) && !isInExcludedRegion(p, root)) chars += visibleText(p).length;
  }
  // Сайты без <p>: учитываем весь текст контейнера.
  if (chars === 0) chars = visibleText(root).length;
  const density = linkDensity(root);
  return { ok: chars >= MIN_BODY_CHARS && density < MAX_LINK_DENSITY, chars, linkDensity: density };
}

/** Явно размеченное тело статьи: id из фрагмента URL в JSON-LD или itemprop="articleBody". */
export function findMarkedRoot(doc: Document, fragmentIds: string[]): RootCandidate | null {
  for (const id of fragmentIds) {
    const el = doc.getElementById(id);
    if (usable(el) && validateRoot(el).ok) return { root: el, method: "jsonld.fragment" };
  }
  for (const el of Array.from(doc.querySelectorAll('[itemprop="articleBody"]'))) {
    if (usable(el) && validateRoot(el).ok) return { root: el, method: "itemprop.articleBody" };
  }
  return null;
}

/**
 * Оценка контейнеров по абзацам, как в Readability, но на исходном DOM и без его изменения.
 * Соседние контейнеры с текстом (например, разделённые рекламой) объединяются через общего родителя.
 */
export function findScoredRoot(doc: Document): RootCandidate | null {
  const scores = new Map<Element, number>();
  for (const p of Array.from(doc.body?.querySelectorAll("p, pre, td, blockquote") ?? [])) {
    if (isHiddenDeep(p) || isInExcludedRegion(p)) continue;
    const text = visibleText(p);
    if (text.length < 25) continue;
    const score = 1 + (text.match(/[,，]/g)?.length ?? 0) + Math.min(text.length / 100, 3);
    const parent = p.parentElement;
    if (!parent) continue;
    scores.set(parent, (scores.get(parent) ?? 0) + score);
    const grand = parent.parentElement;
    if (grand && grand.tagName !== "BODY") scores.set(grand, (scores.get(grand) ?? 0) + score / 2);
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, raw] of scores) {
    const s = raw * (1 - linkDensity(el));
    if (s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  if (!best) return null;

  const parent = best.parentElement;
  if (parent && parent.tagName !== "BODY") {
    const siblingsWithText = Array.from(parent.children).filter(
      (c) => c !== best && (scores.get(c) ?? 0) * (1 - linkDensity(c)) >= bestScore * 0.2 && !isInExcludedRegion(c),
    );
    if (siblingsWithText.length > 0) best = parent;
  }
  return { root: best, method: "dom.score" };
}

/** Наименьший общий предок набора элементов. */
export function commonAncestor(els: Element[]): Element | null {
  if (els.length === 0) return null;
  let common: Element | null = els[0]!.parentElement;
  for (const el of els.slice(1)) {
    while (common && !common.contains(el)) common = common.parentElement;
  }
  return common;
}
