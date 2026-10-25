// Работа с текстом и видимостью элементов. Не изменяет DOM.

const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "CANVAS"]);

/** Схлопывает пробельные символы (включая неразрывный пробел) в один пробел. */
export function normalizeSpace(text: string): string {
  return text.replace(/[\s ​⁠﻿]+/g, " ").trim();
}

/** Нормализация для сравнения строк: регистр, «ё», кавычки, тире и концевая пунктуация. */
export function normalizeForMatch(text: string): string {
  return normalizeSpace(text)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»„“”"‘’'`]/g, "")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[\s.,:;!?…]+$/u, "");
}

/** Видимый текст элемента без скриптов и скрытых потомков; пробелы нормализованы. */
export function visibleText(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (SKIP_TEXT_TAGS.has(child.tagName.toUpperCase())) return;
    if (child !== el && isHidden(child)) return;
    if (child.tagName === "BR") {
      parts.push(" ");
      return;
    }
    for (const n of Array.from(child.childNodes)) walk(n);
  };
  walk(el);
  return normalizeSpace(parts.join(""));
}

let hiddenCache = new WeakMap<Element, boolean>();

/** Сбрасывает кэш видимости: страница могла измениться с прошлого извлечения. */
export function resetVisibilityCache(): void {
  hiddenCache = new WeakMap();
}

/** Признаки скрытого элемента, проверяемые без раскладки (подходит и для jsdom). */
export function isHidden(el: Element): boolean {
  const cached = hiddenCache.get(el);
  if (cached !== undefined) return cached;
  let hidden =
    el.hasAttribute("hidden") ||
    el.getAttribute("aria-hidden") === "true" ||
    (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden");
  if (!hidden) {
    const view = el.ownerDocument.defaultView;
    const style = view?.getComputedStyle ? view.getComputedStyle(el) : null;
    hidden = !!style && (style.display === "none" || style.visibility === "hidden");
  }
  hiddenCache.set(el, hidden);
  return hidden;
}

/** Скрыт ли сам элемент или любой его предок. */
export function isHiddenDeep(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (isHidden(cur)) return true;
  }
  return false;
}

/** Доля символов, приходящихся на текст ссылок. */
export function linkDensity(el: Element): number {
  const total = visibleText(el).length;
  if (total === 0) return 0;
  let linked = 0;
  for (const a of Array.from(el.querySelectorAll("a"))) linked += visibleText(a).length;
  return Math.min(1, linked / total);
}

/** Сходство двух строк по множеству слов (коэффициент Жаккара). */
export function wordSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeForMatch(a).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const wb = new Set(normalizeForMatch(b).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common);
}
