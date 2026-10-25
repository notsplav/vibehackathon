// Детерминированное извлечение статьи с живой страницы (ТЗ раздел 5). Исходный DOM не изменяется.

import {
  SCHEMA_VERSION,
  type Block,
  type ExtractedArticle,
  type ExtractionErrorCode,
} from "../../../shared/contract.ts";
import { resolveAuthors } from "./authors.ts";
import { type BlockDraft, collectBodyBlocks, textFingerprint } from "./blocks.ts";
import { resolveDates } from "./dates.ts";
import { headlineMatches, parseJsonLd, selectArticle, stringValue } from "./jsonld.ts";
import { probablyReaderable, runReadabilityOnClone } from "./readability.ts";
import { isInExcludedRegion } from "./regions.ts";
import { type RootCandidate, commonAncestor, findMarkedRoot, findScoredRoot, validateRoot } from "./root.ts";
import { isHiddenDeep, normalizeForMatch, visibleText } from "./text.ts";
import { urlFragment } from "./url.ts";

export interface ExtractionResult {
  article: ExtractedArticle;
  /** blockId → элемент живой страницы. Остаётся в content script и не сериализуется. */
  elements: Map<string, Element>;
  /** Отпечаток текста блоков для обнаружения замены DOM. */
  fingerprint: string;
}

const SUBTITLE_CLASS = /(^|[\s_-])(subtitle|sub-?title|subhead\w*|lead|dek|standfirst|announce|summary|excerpt|intro)([\s_-]|$)/i;
/** Доля абзацев Readability, которые должны лежать внутри выбранного корня. */
const MIN_READABILITY_AGREEMENT = 0.6;

export function extractArticle(doc: Document, pageUrl: string = doc.URL): ExtractionResult {
  const warnings: string[] = [];
  const methods: string[] = [];

  const canonicalUrl = absolute(doc.querySelector('link[rel="canonical"]')?.getAttribute("href"), pageUrl)
    ?? absolute(doc.querySelector('meta[property="og:url"]')?.getAttribute("content"), pageUrl);

  const h1s = Array.from(doc.querySelectorAll("h1")).filter((h) => !isHiddenDeep(h) && !isInExcludedRegion(h));
  const parsed = parseJsonLd(doc);
  warnings.push(...parsed.warnings);
  const match = selectArticle(parsed, { pageUrl, canonicalUrl, h1Texts: h1s.map(visibleText) });
  const ld = match?.node ?? null;
  if (ld) methods.push("jsonld");
  else if (parsed.nodes.length > 0) warnings.push("jsonld: нет Article, относящегося к этой странице");

  const ldHeadline = ld ? (stringValue(ld["headline"]) ?? stringValue(ld["name"])) : null;
  const ldSubtitle = ld ? stringValue(ld["alternativeHeadline"]) : null;

  // --- Основной текст ---
  const fragmentIds = (match?.urls ?? []).map(urlFragment).filter((x): x is string => !!x);
  let candidate: RootCandidate | null = findMarkedRoot(doc, fragmentIds);
  const strongRoot = candidate !== null;
  if (!candidate) {
    const scored = findScoredRoot(doc);
    if (scored && validateRoot(scored.root).ok) candidate = scored;
  }

  const readability = runReadabilityOnClone(doc);
  if (!readability) warnings.push("readability: не удалось разобрать клон страницы");
  if (readability && readability.originalElements.length > 0) {
    const readRoot = commonAncestor(readability.originalElements);
    const agreement = candidate
      ? readability.originalElements.filter((el) => candidate!.root.contains(el)).length / readability.originalElements.length
      : 0;
    if (candidate && agreement < MIN_READABILITY_AGREEMENT) {
      warnings.push(`readability: совпадение с найденным текстом ${Math.round(agreement * 100)}%`);
      if (!strongRoot && readRoot && validateRoot(readRoot).ok) candidate = { root: readRoot, method: "readability" };
    } else if (!candidate && readRoot && validateRoot(readRoot).ok) {
      candidate = { root: readRoot, method: "readability" };
    }
  }

  // --- Заголовок и подзаголовок ---
  const titleEl = pickTitle(h1s, ldHeadline, candidate?.root ?? null);
  const subtitleEl = titleEl ? pickSubtitle(titleEl, ldSubtitle, candidate?.root ?? null) : null;

  const looksLikeArticle =
    !!ld || doc.querySelector('meta[property="og:type"][content="article" i]') !== null || probablyReaderable(doc);

  const fail = (code: ExtractionErrorCode, message: string): ExtractionResult =>
    result(doc, pageUrl, canonicalUrl, ld ? "article" : "unknown", emptyMetadata(ldHeadline), [], new Map(), {
      status: "failed",
      method: methods.join("+") || "none",
      warnings,
      error: { code, message },
    });

  const bodyText = doc.body ? visibleText(doc.body) : "";
  if (bodyText.length < 50) return fail("empty_page", "Страница пустая или текст ещё не загрузился.");
  if (!candidate) {
    return looksLikeArticle
      ? fail("low_confidence", "Не удалось надёжно определить основной текст статьи.")
      : fail("not_article", "Страница не похожа на статью.");
  }
  methods.push(candidate.method === "readability" ? "readability" : "dom");

  const skip = new Set([titleEl, subtitleEl].filter((x): x is Element => !!x));
  const drafts: BlockDraft[] = [];
  if (titleEl) drafts.push({ type: "title", el: titleEl, text: visibleText(titleEl), links: [] });
  if (subtitleEl) drafts.push({ type: "subtitle", el: subtitleEl, text: visibleText(subtitleEl), links: [] });
  drafts.push(...collectBodyBlocks(candidate.root, skip, warnings));

  const bodyChars = drafts.filter((d) => d.type !== "title" && d.type !== "subtitle" && d.type !== "caption")
    .reduce((n, d) => n + d.text.length, 0);
  if (bodyChars < 200) {
    return looksLikeArticle
      ? fail("low_confidence", "Найден слишком короткий текст, чтобы считать его статьёй.")
      : fail("not_article", "Страница не похожа на статью.");
  }

  const elements = new Map<string, Element>();
  const blocks: Block[] = drafts.map((d, i) => {
    const id = `b${i + 1}`;
    elements.set(id, d.el);
    return { id, type: d.type, order: i + 1, text: d.text, links: d.links };
  });

  // --- Метаданные ---
  const header = headerArea(titleEl, candidate.root);
  const dates = resolveDates({
    doc,
    anchors: [titleEl, candidate.root].filter((x): x is Element => !!x),
    jsonldPublished: ld ? stringValue(ld["datePublished"]) : null,
    jsonldModified: ld ? stringValue(ld["dateModified"]) : null,
  });
  warnings.push(...dates.warnings);
  const authors = resolveAuthors({ doc, jsonldAuthor: ld?.["author"], byId: parsed.byId, scope: header });
  warnings.push(...authors.warnings);
  if (!authors.authors.length && readability?.byline) {
    warnings.push(`author: не найден в разметке, Readability предлагает «${readability.byline}»`);
  }

  const titleText = titleEl ? visibleText(titleEl) : null;
  if (ldHeadline && titleText && !headlineMatches(ldHeadline, titleText)) warnings.push("headline: JSON-LD не совпадает с видимым <h1>");

  return result(
    doc,
    pageUrl,
    canonicalUrl,
    "article",
    {
      title: titleText ?? ldHeadline ?? metaContent(doc, "og:title"),
      subtitle: subtitleEl ? visibleText(subtitleEl) : null,
      authors: authors.authors,
      publishedAt: dates.publishedAt,
      modifiedAt: dates.modifiedAt,
    },
    blocks,
    elements,
    { status: "ok", method: methods.join("+"), warnings },
  );
}

function result(
  doc: Document,
  url: string,
  canonicalUrl: string | null,
  pageType: ExtractedArticle["pageType"],
  metadata: ExtractedArticle["metadata"],
  blocks: Block[],
  elements: Map<string, Element>,
  extraction: ExtractedArticle["extraction"],
): ExtractionResult {
  const language = doc.documentElement.getAttribute("lang")?.trim().split(/[-_]/)[0]?.toLowerCase() || null;
  return {
    article: { schemaVersion: SCHEMA_VERSION, url, canonicalUrl, language, pageType, metadata, blocks, extraction },
    elements,
    fingerprint: textFingerprint(blocks.map((b) => b.text)),
  };
}

function emptyMetadata(title: string | null): ExtractedArticle["metadata"] {
  return { title, subtitle: null, authors: [], publishedAt: null, modifiedAt: null };
}

function absolute(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function metaContent(doc: Document, property: string): string | null {
  return doc.querySelector(`meta[property="${property}"], meta[name="${property}"]`)?.getAttribute("content")?.trim() || null;
}

/** Заголовок статьи: h1, совпадающий с headline, иначе ближайший к телу статьи. */
function pickTitle(h1s: Element[], headline: string | null, root: Element | null): Element | null {
  if (headline) {
    const exact = h1s.find((h) => headlineMatches(headline, visibleText(h)));
    if (exact) return exact;
  }
  if (root) {
    let best: Element | null = null;
    let bestDepth = -1;
    for (const h of h1s) {
      const common = commonAncestor([h, root]);
      let depth = 0;
      for (let cur = common; cur; cur = cur.parentElement) depth++;
      if (depth > bestDepth) {
        best = h;
        bestDepth = depth;
      }
    }
    if (best) return best;
  }
  return h1s[0] ?? null;
}

/**
 * Подзаголовок: элемент рядом с заголовком, совпадающий с alternativeHeadline,
 * либо следующий за h1 элемент с классом подзаголовка/лида.
 */
function pickSubtitle(title: Element, alternative: string | null, root: Element | null): Element | null {
  const near: Element[] = [];
  for (let scope: Element | null = title, level = 0; scope && level < 3; scope = scope.parentElement, level++) {
    for (let sib = scope.nextElementSibling, n = 0; sib && n < 6; sib = sib.nextElementSibling, n++) {
      if (root && sib.contains(root)) break;
      near.push(sib, ...Array.from(sib.querySelectorAll("p, div, h2, span")).slice(0, 20));
    }
  }
  const candidates = near.filter((el) => !isHiddenDeep(el) && !isInExcludedRegion(el));
  if (alternative) {
    const target = normalizeForMatch(alternative);
    const exact = candidates.find((el) => normalizeForMatch(visibleText(el)) === target);
    if (exact) return exact;
  }
  const next = title.nextElementSibling;
  if (next && !isHiddenDeep(next) && (next.tagName === "H2" || SUBTITLE_CLASS.test(next.getAttribute("class") ?? ""))) {
    const text = visibleText(next);
    if (text.length >= 20 && text.length <= 400 && !(root && root.contains(next))) return next;
  }
  return null;
}

/** Область для поиска byline: общий предок заголовка и тела статьи, без поднятия до <body>. */
function headerArea(title: Element | null, root: Element): Element {
  if (!title) return root;
  return commonAncestor([title, root]) ?? root;
}
