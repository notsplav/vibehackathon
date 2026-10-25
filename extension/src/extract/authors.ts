// Автор публикации (ТЗ 5.1, п. 4): author выбранного Article, затем метаданные, затем видимый byline.

import type { Author } from "../../../shared/contract.ts";
import { type JsonLdNode, nodeTypes, resolveRef, stringValue } from "./jsonld.ts";
import { isInExcludedRegion } from "./regions.ts";
import { isHiddenDeep, normalizeForMatch, normalizeSpace, visibleText } from "./text.ts";

const BYLINE_SELECTOR = [
  '[rel="author"]',
  '[itemprop="author"]',
  '[class*="author" i]',
  '[class*="byline" i]',
  '[id*="author" i]',
  '[class*="writer" i]',
].join(", ");

function fromJsonLd(value: unknown, byId: Map<string, JsonLdNode>): Omit<Author, "source" | "quality">[] {
  const out: Omit<Author, "source" | "quality">[] = [];
  const add = (v: unknown): void => {
    v = resolveRef(v, byId);
    if (Array.isArray(v)) return v.forEach(add);
    if (typeof v === "string") {
      // Иногда author — строка с несколькими именами через запятую.
      for (const name of v.split(/\s*[,;]\s*|\s+и\s+/)) if (normalizeSpace(name)) out.push({ name: normalizeSpace(name), type: "person" });
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const node = v as JsonLdNode;
    const name = stringValue(node["name"]);
    if (!name) return;
    const type = nodeTypes(node).includes("organization") || nodeTypes(node).includes("newsmediaorganization") ? "organization" : "person";
    const url = typeof node["url"] === "string" ? node["url"] : undefined;
    out.push(url ? { name, type, url } : { name, type });
  };
  add(value);
  return out;
}

/** Видимые подписи авторов рядом с заголовком. */
function visibleBylines(scope: Element | null): string[] {
  if (!scope) return [];
  const texts: string[] = [];
  for (const el of Array.from(scope.querySelectorAll(BYLINE_SELECTOR))) {
    if (isHiddenDeep(el) || isInExcludedRegion(el)) continue;
    const text = visibleText(el);
    if (text && text.length <= 200) texts.push(text);
  }
  return texts;
}

/** Имя сверяется только с подписями, а не со всем текстом: герой публикации — не автор. */
function nameVisible(name: string, bylines: string[]): boolean {
  const n = normalizeForMatch(name);
  return bylines.some((b) => normalizeForMatch(b).includes(n));
}

export interface AuthorInputs {
  doc: Document;
  jsonldAuthor: unknown;
  byId: Map<string, JsonLdNode>;
  /** Область вокруг заголовка, где ищется byline. */
  scope: Element | null;
}

export function resolveAuthors(input: AuthorInputs): { authors: Author[]; warnings: string[] } {
  const warnings: string[] = [];
  const bylines = visibleBylines(input.scope);

  const structured = fromJsonLd(input.jsonldAuthor, input.byId);
  if (structured.length > 0) {
    const authors = structured.map((a): Author => ({
      ...a,
      source: "jsonld.author",
      quality: nameVisible(a.name, bylines) ? "confirmed" : "plausible",
    }));
    return { authors: dedupe(authors), warnings };
  }

  const meta = input.doc.querySelector('meta[name="author"], meta[property="article:author"], meta[name="article:author"]');
  const metaValue = meta?.getAttribute("content")?.trim();
  // article:author часто содержит URL профиля, а не имя.
  if (metaValue && !/^https?:\/\//i.test(metaValue)) {
    const authors = metaValue
      .split(/\s*[,;]\s*/)
      .filter(Boolean)
      .map((name): Author => ({
        name,
        type: "person",
        source: "meta.author",
        quality: nameVisible(name, bylines) ? "confirmed" : "plausible",
      }));
    return { authors: dedupe(authors), warnings };
  }

  // Видимый byline: берём короткую подпись без даты, отрезая служебные слова.
  for (const text of bylines) {
    const cleaned = normalizeSpace(text.replace(/^(автор|текст|by)\s*[:：]?\s*/i, "").replace(/\(.*?\)/g, ""));
    if (cleaned.length >= 3 && cleaned.length <= 80 && !/\d{2}/.test(cleaned)) {
      return { authors: [{ name: cleaned, type: "person", source: "dom.byline", quality: "plausible" }], warnings };
    }
  }
  return { authors: [], warnings };
}

function dedupe(authors: Author[]): Author[] {
  const seen = new Set<string>();
  return authors.filter((a) => {
    const key = normalizeForMatch(a.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
