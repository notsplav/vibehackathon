// Проверка выделенного фрагмента. На сервер уходят только выделенные блоки и небольшой контекст вокруг:
// заголовок, подзаголовок, до двух абзацев перед выделением и один после. Из контекста утверждения не берутся —
// он нужен модели, чтобы понять, кто «он», какое «вчера» и о какой команде речь.

import type { ArticleFocus, Block, ExtractedArticle } from "../../../shared/contract.ts";
import { normalizeSpace } from "../../../shared/text.ts";
import { textFingerprint } from "../extract/blocks.ts";
import { extractArticle } from "../extract/index.ts";
import { isHiddenDeep, visibleText } from "../extract/text.ts";

export const MIN_SELECTION_CHARS = 10;
export const MAX_SELECTION_CHARS = 8000;
const CONTEXT_BEFORE_BLOCKS = 2;
const CONTEXT_BEFORE_CHARS = 1200;
const CONTEXT_AFTER_BLOCKS = 1;

export type SelectionResult =
  | { ok: true; article: ExtractedArticle; elements: Map<string, Element>; fingerprint: string }
  | { ok: false; error: string };

/** Выделенный текст и диапазон; если выделение пропало (например, после клика в панели), ищем по подсказке. */
function currentSelection(win: Window, hint: string | null, onlyHint: boolean): { text: string; range: Range | null } {
  const sel = win.getSelection();
  if (!onlyHint && sel && !sel.isCollapsed && sel.rangeCount > 0) return { text: normalizeSpace(sel.toString()), range: sel.getRangeAt(0) };
  return { text: normalizeSpace(hint ?? ""), range: null };
}

function intersects(range: Range | null, el: Element, text: string, blockText: string): boolean {
  if (range) return range.intersectsNode(el);
  // Без диапазона — блоки, в которых встречается начало или конец подсказки.
  const head = text.slice(0, 60);
  const tail = text.slice(-60);
  return blockText.includes(head) || blockText.includes(tail);
}

/** `onlyHint` — повторная проверка того же фрагмента: берём сохранённый текст, а не новое выделение. */
export function selectionArticle(win: Window, hint: string | null = null, onlyHint = false): SelectionResult {
  const doc = win.document;
  const { text, range } = currentSelection(win, hint, onlyHint);
  if (text.length < MIN_SELECTION_CHARS) return { ok: false, error: "Выделите на странице текст для проверки — хотя бы одно предложение." };
  if (text.length > MAX_SELECTION_CHARS) return { ok: false, error: "Слишком большой фрагмент. Выделите меньше или проверьте всю статью." };

  const full = extractArticle(doc, win.location.href);
  if (full.article.extraction.status === "ok") {
    const blocks = full.article.blocks;
    const focusIdx = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.type !== "caption" && intersects(range, full.elements.get(b.id)!, text, b.text))
      .map(({ i }) => i);
    if (focusIdx.length > 0) {
      const first = focusIdx[0]!;
      const last = focusIdx[focusIdx.length - 1]!;
      const keep = new Set<number>(focusIdx);
      // Заголовок и подзаголовок задают тему и время, абзацы рядом — местоимения и детали.
      blocks.forEach((b, i) => (b.type === "title" || b.type === "subtitle") && keep.add(i));
      let chars = 0;
      for (let i = first - 1, n = 0; i >= 0 && n < CONTEXT_BEFORE_BLOCKS && chars < CONTEXT_BEFORE_CHARS; i--) {
        if (blocks[i]!.type === "caption") continue;
        keep.add(i);
        chars += blocks[i]!.text.length;
        n++;
      }
      for (let i = last + 1, n = 0; i < blocks.length && n < CONTEXT_AFTER_BLOCKS; i++) {
        if (blocks[i]!.type === "caption") continue;
        keep.add(i);
        n++;
      }
      const focus: ArticleFocus = { blockIds: focusIdx.map((i) => blocks[i]!.id), text };
      const subset = [...keep].sort((a, b) => a - b).map((i) => blocks[i]!);
      return { ok: true, article: { ...full.article, blocks: subset, focus }, elements: full.elements, fingerprint: full.fingerprint };
    }
  }
  return fallbackArticle(win, text, range, full.article);
}

const BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, figcaption, article, section, div";

/** Выделение вне найденной статьи: блоком становится абзац с выделением, контекстом — соседние абзацы. */
function fallbackArticle(win: Window, text: string, range: Range | null, base: ExtractedArticle): SelectionResult {
  const doc = win.document;
  const anchor = range?.commonAncestorContainer ?? null;
  const start = anchor ? (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement) : null;
  const focusEl = start?.closest(BLOCK_SELECTOR) ?? null;
  if (!focusEl || isHiddenDeep(focusEl)) return { ok: false, error: "Не удалось найти выделенный текст на странице. Выделите его ещё раз." };

  const siblings = (dir: "previousElementSibling" | "nextElementSibling", max: number): Element[] => {
    const out: Element[] = [];
    for (let el = focusEl[dir]; el && out.length < max; el = el[dir]) if (!isHiddenDeep(el) && visibleText(el).length > 30) out.push(el);
    return out;
  };
  const h1 = Array.from(doc.querySelectorAll("h1")).find((h) => !isHiddenDeep(h) && !h.contains(focusEl));
  const ordered: { el: Element | null; type: Block["type"]; text: string }[] = [];
  const title = h1 ? visibleText(h1) : normalizeSpace(doc.title);
  if (title) ordered.push({ el: h1 ?? null, type: "title", text: title });
  for (const el of siblings("previousElementSibling", CONTEXT_BEFORE_BLOCKS).reverse()) ordered.push({ el, type: "paragraph", text: visibleText(el) });
  ordered.push({ el: focusEl, type: "paragraph", text: visibleText(focusEl) });
  for (const el of siblings("nextElementSibling", CONTEXT_AFTER_BLOCKS)) ordered.push({ el, type: "paragraph", text: visibleText(el) });

  const elements = new Map<string, Element>();
  const blocks: Block[] = ordered.map((o, i) => {
    const id = `b${i + 1}`;
    if (o.el) elements.set(id, o.el);
    return { id, type: o.type, order: i + 1, text: o.text.slice(0, 20_000), links: [] };
  });
  const focusId = blocks[ordered.findIndex((o) => o.el === focusEl)]!.id;
  const article: ExtractedArticle = {
    ...base,
    pageType: base.pageType,
    metadata: { ...base.metadata, title: base.metadata.title ?? title ?? null },
    blocks,
    extraction: { status: "ok", method: "selection", warnings: [...base.extraction.warnings, "selection: статья не найдена, контекст — соседние абзацы"] },
    focus: { blockIds: [focusId], text },
  };
  return { ok: true, article, elements, fingerprint: textFingerprint([...elements.values()].map(visibleText)) };
}
