// Разбиение основного текста на блоки в порядке чтения (ТЗ 5.3). Исходный DOM не изменяется.

import type { Block, BlockLink, BlockType } from "../../../shared/contract.ts";
import { isExcludedElement } from "./regions.ts";
import { isHidden, linkDensity, visibleText } from "./text.ts";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "CANVAS", "VIDEO", "AUDIO", "PICTURE", "IMG", "TABLE", "PRE", "CODE", "INPUT", "LABEL"]);
const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "LI", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "TABLE", "PRE", "DL", "DD", "DT", "HR"]);

/** Служебные элементы внутри тела статьи: подписи автора, даты, теги, кнопки «поделиться». */
const SERVICE_IN_ROOT = /(^|[\s_-])(byline|author|authors|date|dateline|time|meta|credits?|share|sharing|tags|toolbar|rubric|breadcrumbs?|read-?more|see-?also)([\s_-]|$)/i;
const QUOTE_CONTAINER = /(^|[\s_-])(quote|blockquote|citation|pullquote)([\s_-]|$)/i;
const CAPTION_CLASS = /(^|[\s_-])(caption|figcaption|photo-?credit)([\s_-]|$)/i;
// \b в JS работает только для латиницы, поэтому граница слова задана явно.
const BOILERPLATE = /^(реклама|advertisement|читайте также|смотрите также|читайте нас|подписывайтесь|подпишитесь)(?=[\s:.,!—-]|$)/iu;

export interface BlockDraft {
  type: BlockType;
  el: Element;
  text: string;
  links: BlockLink[];
}

function classOf(el: Element): string {
  return `${el.getAttribute("class") ?? ""} ${el.id}`;
}

function collectLinks(el: Element): BlockLink[] {
  const links: BlockLink[] = [];
  for (const a of Array.from(el.querySelectorAll("a[href]"))) {
    const href = (a as HTMLAnchorElement).href;
    if (!/^https?:/i.test(href)) continue;
    links.push({ href, text: visibleText(a) });
  }
  return links;
}

function hasBlockChildren(el: Element): boolean {
  return Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName));
}

/** Есть ли у элемента собственный текст вне дочерних блоков (текст прямо в <div> с <br>). */
function ownTextLength(el: Element): number {
  let len = 0;
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) len += (n.nodeValue ?? "").trim().length;
    else if (n.nodeType === 1 && !BLOCK_TAGS.has((n as Element).tagName)) len += visibleText(n as Element).length;
  }
  return len;
}

/**
 * Обходит корень и возвращает блоки. Элементы из `skip` (заголовок и подзаголовок, добавленные отдельно)
 * не попадают в результат. Вложенный абзац и его контейнер не дублируются: в блок попадает только лист.
 */
export function collectBodyBlocks(root: Element, skip: Set<Element>, warnings: string[]): BlockDraft[] {
  const out: BlockDraft[] = [];

  const emit = (el: Element, type: BlockType): void => {
    const text = visibleText(el);
    if (!text) return;
    if (BOILERPLATE.test(text)) return;
    // Блок целиком внутри ссылки — карточка другой статьи, а не текст этой.
    const link = el.closest("a[href]");
    if (link && root.contains(link)) return;
    // Заголовок-ссылка — карточка другой статьи («Читайте также»), а не раздел этой.
    if (type === "heading" && linkDensity(el) > 0.8) return;
    // Абзац-ссылка вида «Читайте также: …» — это рекомендация, а не текст статьи.
    if (type === "paragraph" && text.length < 200 && linkDensity(el) > 0.8) return;
    out.push({ type, el, text, links: collectLinks(el) });
  };

  const walk = (el: Element, inQuote: boolean, inFigure: boolean): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName;
      if (skip.has(child) || SKIP_TAGS.has(tag) || isHidden(child) || isExcludedElement(child)) continue;
      const cls = classOf(child);
      if (SERVICE_IN_ROOT.test(cls) && !/content|text|body/i.test(cls)) continue;

      if (/^H[1-6]$/.test(tag)) {
        emit(child, "heading");
      } else if (tag === "FIGCAPTION" || (inFigure && CAPTION_CLASS.test(cls))) {
        emit(child, "caption");
      } else if (tag === "FIGURE") {
        walk(child, inQuote, true);
      } else if (tag === "BLOCKQUOTE" || QUOTE_CONTAINER.test(cls)) {
        if (hasBlockChildren(child)) walk(child, true, inFigure);
        else emit(child, "quote");
      } else if (tag === "P") {
        emit(child, inQuote ? "quote" : inFigure && CAPTION_CLASS.test(cls) ? "caption" : "paragraph");
      } else if (tag === "LI") {
        if (hasBlockChildren(child)) walk(child, inQuote, inFigure);
        else emit(child, "list_item");
      } else if (hasBlockChildren(child)) {
        if (ownTextLength(child) >= 80) warnings.push("blocks: текст вперемешку с блоками, часть текста может быть пропущена");
        walk(child, inQuote, inFigure);
      } else if (!inFigure) {
        // Лист без блочных потомков (<div> с текстом). Короткие подписи вроде «Имя, должность» пропускаем.
        const text = visibleText(child);
        if (text.length >= 80 && /[.!?…»"]/.test(text)) emit(child, inQuote ? "quote" : "paragraph");
      }
    }
  };

  walk(root, false, false);
  return out;
}

/** Короткий отпечаток текста блоков для обнаружения изменения DOM после анализа (FNV-1a, 32 бита). */
export function textFingerprint(texts: string[]): string {
  let h = 0x811c9dc5;
  const s = texts.join("\n");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
