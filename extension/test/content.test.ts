import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Claim } from "../../shared/contract.ts";
import { handleClick, handleMessage } from "../src/content/index.ts";
import { ROOT } from "./fixtures.ts";
import { loadDocument } from "./load.ts";

function setup() {
  const doc = loadDocument(join(ROOT, "fixtures/pages/jsonld-array-recommended.html"), "https://news.example.test/city/2026/09/14/biblioteka/");
  const win = doc.defaultView as unknown as Window & typeof globalThis;
  const extracted = handleMessage(win, { type: "vh:extract" });
  if (!extracted.ok || !("article" in extracted)) throw new Error("extract failed");
  return { doc, win, article: extracted.article, fingerprint: extracted.fingerprint };
}

const claim = (id: string, blockId: string, exactText: string, patch: Partial<Claim> = {}): Claim => ({
  id,
  blockIds: [blockId],
  exactText,
  occurrences: [{ blockId, exactText }],
  normalizedClaim: exactText,
  kind: "other",
  status: "checked",
  verdict: "supported",
  explanation: null,
  evidence: [],
  ...patch,
});

describe("маркеры и карточка на живой странице", () => {
  test("помечает блоки, не меняя текст; клик по абзацу открывает карточку, по ссылке — нет", () => {
    const { doc, win, article, fingerprint } = setup();
    const p = article.blocks.find((b) => b.text.startsWith("Фонд библиотеки"))!;
    const textBefore = doc.body.textContent;
    const claims = [
      claim("c1", p.id, "Фонд библиотеки насчитывает около 40 тысяч книг", {
        explanation: '<img src=x onerror="alert(1)"> объяснение',
        evidence: [
          { url: "https://city.example.org/n/1", title: "Пресс-служба", retrievedAt: "2026-09-14T10:00:00Z", role: "primary", relation: null, grounding: { interactionId: null, annotationIndex: 0 } },
          { url: "javascript:alert(1)", title: "bad", retrievedAt: "2026-09-14T10:00:00Z", role: "unknown", relation: null, grounding: { interactionId: null, annotationIndex: 1 } },
        ],
      }),
      claim("c2", p.id, "детская литература занимает треть", { status: "checking", verdict: null }),
    ];
    const reply = handleMessage(win, { type: "vh:render", claims, fingerprint });
    expect(reply).toEqual({ ok: true, stale: false, marked: 1 });

    const el = doc.querySelector('[data-vh-status]')!;
    expect(el.textContent).toContain("Фонд библиотеки");
    expect(el.getAttribute("data-vh-status")).toBe("checking");
    // Текст статьи не меняется: стили в <head>, значки — через ::after.
    expect(doc.body.textContent).toBe(textBefore);

    // Клик по ссылке внутри абзаца: карточка не открывается, переход не отменён.
    const link = el.querySelector("a")!;
    const linkClick = new win.MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(linkClick);
    handleClick(win, linkClick);
    expect(doc.getElementById("vh-factcheck-card")).toBeNull();
    expect(linkClick.defaultPrevented).toBe(false);

    const click = new win.MouseEvent("click", { bubbles: true });
    el.dispatchEvent(click);
    handleClick(win, click);
    const card = doc.getElementById("vh-factcheck-card")!.shadowRoot!;
    expect(card.textContent).toContain("Утверждений в блоке: 2");
    expect(card.textContent).toContain('<img src=x onerror="alert(1)"> объяснение');
    expect(card.querySelector("img")).toBeNull();
    expect(Array.from(card.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://city.example.org/n/1"]);
  });

  test("изменённый текст страницы — результат не привязывается", () => {
    const { doc, win, article, fingerprint } = setup();
    const p = article.blocks.find((b) => b.type === "paragraph")!;
    handleMessage(win, { type: "vh:render", claims: [claim("c1", p.id, p.text.slice(0, 20))], fingerprint });
    expect(doc.querySelectorAll("[data-vh-status]").length).toBe(1);

    doc.querySelector(".article__text p")!.append(" Добавленный текст.");
    expect(handleMessage(win, { type: "vh:render", claims: [claim("c1", p.id, p.text.slice(0, 20))], fingerprint })).toEqual({ ok: true, stale: true, marked: 0 });
    expect(doc.querySelectorAll("[data-vh-status]").length).toBe(0);
  });

  test("очистка снимает маркеры и стили", () => {
    const { doc, win, article, fingerprint } = setup();
    handleMessage(win, { type: "vh:render", claims: [claim("c1", article.blocks[2]!.id, article.blocks[2]!.text.slice(0, 15))], fingerprint });
    handleMessage(win, { type: "vh:clear" });
    expect(doc.querySelectorAll("[data-vh-status]").length).toBe(0);
    expect(doc.getElementById("vh-factcheck-style")).toBeNull();
  });
});
