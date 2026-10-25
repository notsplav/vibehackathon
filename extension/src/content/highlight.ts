// Подсветка фрагмента утверждения внутри абзаца через CSS Custom Highlight API:
// DOM статьи не меняется, ссылки и выделение текста работают как раньше.

const NAME = "vh-claim";
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

interface Point {
  node: Text;
  offset: number;
}

/** Range для фрагмента в тексте элемента с теми же правилами нормализации пробелов, что при извлечении. */
export function rangeForText(el: Element, fragment: string): Range | null {
  const doc = el.ownerDocument;
  const points: Point[] = [];
  let text = "";
  const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */, {
    acceptNode: (n) => (n.parentElement && SKIP.has(n.parentElement.tagName.toUpperCase()) ? 2 /* REJECT */ : 1 /* ACCEPT */),
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const value = n.nodeValue ?? "";
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]!;
      if (/[\s ​⁠﻿]/.test(ch)) {
        if (text.length === 0 || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += ch;
      }
      points.push({ node: n, offset: i });
    }
  }
  const needle = fragment.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  let start = text.indexOf(needle);
  if (start < 0) start = text.toLowerCase().indexOf(needle.toLowerCase());
  if (start < 0) return null;
  const from = points[start];
  const to = points[start + needle.length - 1];
  if (!from || !to) return null;
  const range = doc.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset + 1);
  return range;
}

type HighlightWindow = Window & { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...ranges: Range[]) => unknown };

export function highlightFragment(el: Element, fragment: string | null): void {
  const win = el.ownerDocument.defaultView as HighlightWindow | null;
  const registry = win?.CSS?.highlights;
  if (!registry || !win?.Highlight) return;
  const range = fragment ? rangeForText(el, fragment) : null;
  if (range) registry.set(NAME, new win.Highlight(range));
  else registry.delete(NAME);
}

export function clearHighlight(doc: Document): void {
  (doc.defaultView as HighlightWindow | null)?.CSS?.highlights?.delete(NAME);
}

/** Стиль подсветки добавляется в таблицу стилей маркеров. */
export const HIGHLIGHT_CSS = `::highlight(${NAME}){background-color:rgba(255,213,79,.55);color:inherit}`;
