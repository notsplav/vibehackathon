import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";
import { extractArticle } from "../src/extract/index.ts";
import { parseVisibleDates, wallTimesMatch, isoWallTime } from "../src/extract/dates.ts";
import { visibleText } from "../src/extract/text.ts";
import { type ExpectedCase, ROOT, loadExpectedCases, resolveHtml } from "./fixtures.ts";
import { loadDocument } from "./load.ts";

// UPDATE_EXPECTED=1 npm test перезаписывает fixtures/expected фактическим результатом.
// Используйте только после намеренного изменения алгоритма и проверяйте дифф глазами.
const UPDATE = process.env.UPDATE_EXPECTED === "1";

function project(r: ReturnType<typeof extractArticle>["article"]): ExpectedCase["expected"] {
  return {
    status: r.extraction.status,
    method: r.extraction.method,
    ...(r.extraction.error ? { errorCode: r.extraction.error.code } : {}),
    pageType: r.pageType,
    language: r.language,
    canonicalUrl: r.canonicalUrl,
    metadata: r.metadata,
    blocks: r.blocks.map((b) => ({ type: b.type, text: b.text })),
    warnings: r.extraction.warnings,
  };
}

describe("извлечение по fixtures/expected", () => {
  for (const c of loadExpectedCases()) {
    const html = resolveHtml(c);
    const run = html ? test : test.skip;
    run(`${c.name}${html ? "" : " (нет локальной копии: см. description в fixtures/expected)"}`, () => {
      const doc = loadDocument(html!, c.url);
      const before = doc.documentElement.outerHTML;
      const { article, elements } = extractArticle(doc, c.url);

      // Исходный DOM не изменяется, в том числе при запуске Readability.
      expect(doc.documentElement.outerHTML).toBe(before);

      if (UPDATE) {
        const path = join(ROOT, "fixtures/expected", `${c.name}.json`);
        const file = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...file, expected: project(article) }, null, 2) + "\n");
        return;
      }
      expect(project(article)).toEqual(c.expected);

      // Каждый blockId указывает на элемент живой страницы с тем же текстом.
      expect(elements.size).toBe(article.blocks.length);
      for (const block of article.blocks) {
        const el = elements.get(block.id);
        expect(el && doc.contains(el)).toBe(true);
        expect(visibleText(el!)).toBe(block.text);
      }
    });
  }
});

test("пустая страница — empty_page", () => {
  const doc = new JSDOM("<!doctype html><html><head><title>…</title></head><body><div id=app></div></body></html>", {
    url: "https://example.test/",
  }).window.document;
  const { article, elements } = extractArticle(doc);
  expect(article.extraction.status).toBe("failed");
  expect(article.extraction.error?.code).toBe("empty_page");
  expect(article.blocks).toEqual([]);
  expect(elements.size).toBe(0);
});

describe("видимые даты", () => {
  test("форматы подписи", () => {
    expect(parseVisibleDates("12:16, 25 октября 2026")).toEqual([{ year: 2026, month: 10, day: 25, hour: 12, minute: 16 }]);
    expect(parseVisibleDates("1 октября 2026 в 18:45")).toEqual([{ year: 2026, month: 10, day: 1, hour: 18, minute: 45 }]);
    expect(parseVisibleDates("20.08.2026 10:00")).toEqual([{ year: 2026, month: 8, day: 20, hour: 10, minute: 0 }]);
  });

  test("время в UTC совпадает с местным временем на странице, но не с другой минутой", () => {
    const iso = isoWallTime("2026-08-20T09:15:00Z")!;
    expect(wallTimesMatch(iso, parseVisibleDates("20 августа 2026, 12:15")[0]!)).toBe(true);
    expect(wallTimesMatch(iso, parseVisibleDates("20 августа 2026, 12:16")[0]!)).toBe(false);
  });
});
