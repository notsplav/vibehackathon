// Mozilla Readability как запасной способ и контроль качества. Работает только на клоне документа:
// parse() изменяет переданный DOM, поэтому исходная страница в него никогда не передаётся.

import { Readability, isProbablyReaderable } from "@mozilla/readability";

const INDEX_ATTR = "data-vh-idx";
// Заголовки и подписи к фото не учитываются: Readability включает их в content, а мы храним отдельно.
const TEXT_SELECTOR = "p, li, blockquote";

export interface ReadabilityResult {
  title: string | null;
  byline: string | null;
  publishedTime: string | null;
  textLength: number;
  /** Элементы исходной страницы, соответствующие абзацам, которые Readability сочла основным текстом. */
  originalElements: Element[];
}

export function probablyReaderable(doc: Document): boolean {
  return isProbablyReaderable(doc);
}

export function runReadabilityOnClone(doc: Document): ReadabilityResult | null {
  const original = Array.from(doc.getElementsByTagName("*"));
  const clone = doc.cloneNode(true) as Document;
  const copies = Array.from(clone.getElementsByTagName("*"));
  if (copies.length !== original.length) return null;
  // Метки на клоне позволяют вернуться от результата Readability к элементам живой страницы.
  copies.forEach((el, i) => el.setAttribute(INDEX_ATTR, String(i)));

  let parsed: ReturnType<Readability<Element>["parse"]>;
  try {
    parsed = new Readability<Element>(clone, { serializer: (node) => node as Element, charThreshold: 300 }).parse();
  } catch {
    return null;
  }
  const content = parsed?.content;
  if (!parsed || !content) return null;

  const originalElements: Element[] = [];
  for (const el of Array.from(content.querySelectorAll(TEXT_SELECTOR))) {
    // Элементы, созданные самой Readability (например, обёртки абзацев), меток не имеют.
    const mark = el.getAttribute(INDEX_ATTR);
    const orig = mark === null ? undefined : original[Number(mark)];
    if (!orig || orig.closest("figure, figcaption")) continue;
    if ((orig.textContent ?? "").trim().length >= 25) originalElements.push(orig);
  }
  return {
    title: parsed.title ?? null,
    byline: parsed.byline ?? null,
    publishedTime: parsed.publishedTime ?? null,
    textLength: parsed.length ?? 0,
    originalElements,
  };
}
