// Разбор JSON-LD без eval и выбор Article-объекта, относящегося к текущей странице (ТЗ 5.1, п. 1–2).

import { normalizeForMatch, normalizeSpace, wordSimilarity } from "./text.ts";
import { normalizeUrl } from "./url.ts";

export type JsonLdNode = Record<string, unknown>;

const ARTICLE_TYPES = new Set([
  "article",
  "newsarticle",
  "blogposting",
  "reportagenewsarticle",
  "analysisnewsarticle",
  "opinionnewsarticle",
  "backgroundnewsarticle",
  "reviewnewsarticle",
  "liveblogposting",
  "socialmediaposting",
  "scholarlyarticle",
  "techarticle",
  "report",
]);

export interface JsonLdParseResult {
  nodes: JsonLdNode[];
  /** Все узлы с `@id` для разрешения ссылок вида `{ "@id": "..." }`. */
  byId: Map<string, JsonLdNode>;
  warnings: string[];
}

function isObject(v: unknown): v is JsonLdNode {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Тип без префикса словаря: "https://schema.org/NewsArticle" и "schema:NewsArticle" → "newsarticle". */
export function normalizeType(t: string): string {
  return t.trim().replace(/^.*[/#:]/, "").toLowerCase();
}

export function nodeTypes(node: JsonLdNode): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.filter((x): x is string => typeof x === "string").map(normalizeType);
}

export function isArticleNode(node: JsonLdNode): boolean {
  return nodeTypes(node).some((t) => ARTICLE_TYPES.has(t));
}

export function parseJsonLd(doc: Document): JsonLdParseResult {
  const nodes: JsonLdNode[] = [];
  const byId = new Map<string, JsonLdNode>();
  const warnings: string[] = [];

  const collect = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      for (const v of value) collect(v, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    if (typeof value["@id"] === "string" && Object.keys(value).length > 1) byId.set(value["@id"], value);
    if (value["@type"] !== undefined) nodes.push(value);
    if (value["@graph"] !== undefined) collect(value["@graph"], depth + 1);
    // Вложенные сущности (author, publisher, mainEntity) тоже регистрируются для разрешения @id.
    for (const [k, v] of Object.entries(value)) {
      if (k !== "@graph" && (isObject(v) || Array.isArray(v))) collectIds(v, depth + 1);
    }
  };
  const collectIds = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      for (const v of value) collectIds(v, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    if (typeof value["@id"] === "string" && Object.keys(value).length > 1 && !byId.has(value["@id"])) {
      byId.set(value["@id"], value);
    }
    // mainEntity и подобные могут содержать саму статью.
    if (isArticleNode(value) && !nodes.includes(value)) nodes.push(value);
    for (const v of Object.values(value)) if (isObject(v) || Array.isArray(v)) collectIds(v, depth + 1);
  };

  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'));
  scripts.forEach((script, i) => {
    const raw = (script.textContent ?? "").trim();
    if (!raw) return;
    try {
      collect(JSON.parse(raw), 0);
    } catch {
      // Частая поломка — управляющие символы внутри строк; пробуем один раз заменить их пробелами.
      try {
        collect(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " ")), 0);
        warnings.push(`jsonld[${i}]: исправлены управляющие символы`);
      } catch {
        warnings.push(`jsonld[${i}]: некорректный JSON, блок пропущен`);
      }
    }
  });
  return { nodes, byId, warnings };
}

/** Разрешает `{ "@id": "..." }` в полный узел, если он есть в документе. */
export function resolveRef(value: unknown, byId: Map<string, JsonLdNode>): unknown {
  if (isObject(value) && typeof value["@id"] === "string" && Object.keys(value).length === 1) {
    return byId.get(value["@id"]) ?? value;
  }
  return value;
}

export function stringValue(value: unknown): string | null {
  if (typeof value === "string") return normalizeSpace(value) || null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = stringValue(v);
      if (s) return s;
    }
  }
  if (isObject(value) && typeof value["@value"] === "string") return normalizeSpace(value["@value"]) || null;
  return null;
}

function nodeUrls(node: JsonLdNode, byId: Map<string, JsonLdNode>): string[] {
  const urls: string[] = [];
  const add = (v: unknown): void => {
    v = resolveRef(v, byId);
    if (typeof v === "string") urls.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (isObject(v)) {
      if (typeof v["@id"] === "string") urls.push(v["@id"]);
      if (typeof v["url"] === "string") urls.push(v["url"]);
    }
  };
  add(node["url"]);
  add(node["mainEntityOfPage"]);
  if (typeof node["@id"] === "string") urls.push(node["@id"]);
  return urls;
}

export interface ArticleMatch {
  node: JsonLdNode;
  urlMatch: boolean;
  headlineMatch: boolean;
  /** Сырые URL узла (могут содержать фрагмент с id тела статьи). */
  urls: string[];
}

export interface PageIdentity {
  pageUrl: string;
  canonicalUrl: string | null;
  /** Тексты видимых заголовков h1 страницы. */
  h1Texts: string[];
}

export function headlineMatches(headline: string | null, text: string): boolean {
  if (!headline || !text) return false;
  const a = normalizeForMatch(headline);
  const b = normalizeForMatch(text);
  if (a === b) return true;
  if (a.length > 20 && b.length > 20 && (a.includes(b) || b.includes(a))) return true;
  return wordSimilarity(a, b) >= 0.8;
}

/**
 * Выбирает Article, относящийся к текущей странице. Объект рекомендованной статьи
 * не берётся только потому, что встретился первым: нужно совпадение URL или заголовка.
 * Единственный Article без противоречий принимается как правдоподобный.
 */
export function selectArticle(parsed: JsonLdParseResult, page: PageIdentity): ArticleMatch | null {
  const pageUrls = new Set([normalizeUrl(page.pageUrl), normalizeUrl(page.canonicalUrl)].filter(Boolean));
  const candidates = parsed.nodes.filter(isArticleNode).map((node): ArticleMatch => {
    const urls = nodeUrls(node, parsed.byId);
    const urlMatch = urls.some((u) => pageUrls.has(normalizeUrl(u, page.pageUrl)));
    const headline = stringValue(node["headline"]) ?? stringValue(node["name"]);
    const headlineMatch = page.h1Texts.some((h) => headlineMatches(headline, h));
    return { node, urlMatch, headlineMatch, urls };
  });
  if (candidates.length === 0) return null;
  const score = (c: ArticleMatch) => (c.urlMatch ? 2 : 0) + (c.headlineMatch ? 1 : 0);
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  if (score(best) > 0) return best;
  if (candidates.length === 1) {
    const only = candidates[0]!;
    const hasOwnUrl = only.urls.some((u) => normalizeUrl(u, page.pageUrl) !== null);
    // Есть свой URL, и он не совпал со страницей — это чужая статья.
    if (!hasOwnUrl) return only;
  }
  return null;
}
