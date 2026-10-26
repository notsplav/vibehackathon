import { describe, expect, test } from "vitest";
import { type Citation, decideVerdict } from "../evidence.ts";

// Найденные поиском источники (как их собирает помощник из результатов WebSearch).
const CITATIONS: Citation[] = [
  { url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/biographical/", title: "nobelprize.org", annotationIndex: 0, citedText: null },
  { url: "https://example-news.test/curie", title: "example-news.test", annotationIndex: 1, citedText: null },
];
const extractCitations = () => CITATIONS;

describe("правило вердикта", () => {
  const base = { interactionId: "int-test-1", retrievedAt: "2026-10-25T12:00:00Z", articleUrl: "https://example-news.test/article" };

  test("supported без источника из grounding понижается до insufficient", () => {
    const d = decideVerdict({ ...base, verdict: "supported", explanation: "Да", sources: [{ index: 7 }], citations: extractCitations() });
    expect(d.verdict).toBe("insufficient");
    expect(d.evidence).toEqual([]);
    expect(d.downgraded).not.toBeNull();
  });

  test("ссылка на сайт самой статьи не считается подтверждением", () => {
    const d = decideVerdict({ ...base, verdict: "contradicted", explanation: "Нет", sources: [{ index: 2, role: "secondary" }], citations: extractCitations() });
    expect(d.verdict).toBe("insufficient");
  });

  test("источник сохраняет ссылку на аннотацию и роль", () => {
    const d = decideVerdict({
      ...base,
      verdict: "supported",
      explanation: "Подтверждается биографией на сайте Нобелевского комитета.",
      sources: [{ index: 1, role: "primary", relation: "Биография лауреата" }],
      citations: extractCitations(),
    });
    expect(d.verdict).toBe("supported");
    expect(d.evidence).toEqual([
      {
        url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/biographical/",
        title: "nobelprize.org",
        retrievedAt: "2026-10-25T12:00:00Z",
        role: "primary",
        relation: "Биография лауреата",
        grounding: { interactionId: "int-test-1", annotationIndex: 0 },
      },
    ]);
  });
});
