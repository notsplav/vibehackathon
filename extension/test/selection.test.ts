import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { selectionArticle } from "../src/content/selection.ts";
import { ROOT } from "./fixtures.ts";
import { loadDocument } from "./load.ts";

function page() {
  const doc = loadDocument(join(ROOT, "fixtures/pages/jsonld-array-recommended.html"), "https://news.example.test/city/2026/09/14/biblioteka/");
  return { doc, win: doc.defaultView as unknown as Window & typeof globalThis };
}

/** Выделяет текст от `from` до конца `to` (поиск по текстовым узлам). */
function select(doc: Document, from: string, to: string): void {
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const start = nodes.find((n) => n.nodeValue!.includes(from))!;
  const end = nodes.find((n) => n.nodeValue!.includes(to))!;
  const range = doc.createRange();
  range.setStart(start, start.nodeValue!.indexOf(from));
  range.setEnd(end, end.nodeValue!.indexOf(to) + to.length);
  const sel = doc.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("проверка выделенного фрагмента", () => {
  test("выделение посреди абзаца: фокус — этот абзац, контекст — заголовок, подзаголовок, соседи", () => {
    const { doc, win } = page();
    select(doc, "в здании работают коворкинг", "лекторий на 80 мест");
    const r = selectionArticle(win);
    if (!r.ok) throw new Error(r.error);
    const types = r.article.blocks.map((b) => `${b.type}:${b.text.slice(0, 25)}`);
    expect(r.article.focus).toEqual({ blockIds: [expect.any(String)], text: "в здании работают коворкинг и лекторий на 80 мест" });
    const focusBlock = r.article.blocks.find((b) => b.id === r.article.focus!.blockIds[0])!;
    expect(focusBlock.text).toBe("Кроме читальных залов, в здании работают коворкинг и лекторий на 80 мест.");
    expect(types).toEqual([
      "title:В Заречье открылась новая",
      "subtitle:Здание на 1200 квадратных",
      "paragraph:Фонд библиотеки насчитыва",
      "heading:Что есть внутри",
      "paragraph:Кроме читальных залов, в ",
      "list_item:читальный зал на втором э",
    ]);
    // blockId те же, что при извлечении всей статьи: маркеры встают на живые элементы.
    expect(r.elements.get(focusBlock.id)!.textContent).toContain("коворкинг");
  });

  test("выделение через два абзаца — оба в фокусе", () => {
    const { doc, win } = page();
    select(doc, "Об этом сообщила", "занимает треть");
    const r = selectionArticle(win);
    if (!r.ok) throw new Error(r.error);
    expect(r.article.focus!.blockIds).toHaveLength(2);
  });

  test("слишком короткое выделение и пустое выделение — понятная ошибка", () => {
    const { doc, win } = page();
    expect(selectionArticle(win)).toMatchObject({ ok: false, error: expect.stringMatching(/Выделите/) });
    select(doc, "Вход", "Вход");
    expect(selectionArticle(win)).toMatchObject({ ok: false, error: expect.stringMatching(/Выделите/) });
  });

  test("повторная проверка берёт сохранённый текст, а не новое выделение", () => {
    const { doc, win } = page();
    select(doc, "Кроме читальных залов", "лекторий на 80 мест");
    const r = selectionArticle(win, "Библиотека открыта ежедневно, кроме понедельника", true);
    if (!r.ok) throw new Error(r.error);
    expect(r.article.blocks.find((b) => b.id === r.article.focus!.blockIds[0])!.text).toMatch(/^Библиотека открыта ежедневно/);
  });

  test("выделение вне статьи (комментарии): блок — абзац выделения, контекст — соседи", () => {
    const { doc, win } = page();
    select(doc, "Отличная новость", "спасибо всем!");
    const r = selectionArticle(win);
    if (!r.ok) throw new Error(r.error);
    expect(r.article.extraction.method).toBe("selection");
    const focusBlock = r.article.blocks.find((b) => b.id === r.article.focus!.blockIds[0])!;
    expect(focusBlock.text).toMatch(/^Отличная новость/);
    expect(r.article.blocks[0]!.type).toBe("title");
  });
});
