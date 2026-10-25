import { describe, expect, test } from "vitest";
import { decideVerdict, extractCitations, type InteractionLike } from "../src/pipeline/evidence.ts";

// Синтетический ответ по типам @google/genai 2.31.0 (ModelOutputStep → TextContent.annotations → URLCitation).
// Только для тестов разбора; в работе сервер никогда не подставляет такие данные.
const SYNTHETIC: InteractionLike = {
  id: "int-test-1",
  steps: [
    { type: "google_search_call", id: "s1", arguments: { queries: ["Мария Кюри дата рождения"] } },
    { type: "google_search_result", call_id: "s1", result: [{ search_suggestions: "<div>…</div>" }] },
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "Мария Кюри родилась 7 ноября 1867 года в Варшаве.",
          annotations: [
            { type: "url_citation", url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/biographical/", title: "nobelprize.org", start_index: 0, end_index: 48 },
            { type: "url_citation", url: "https://www.nobelprize.org/prizes/physics/1903/marie-curie/biographical/", title: "nobelprize.org", start_index: 0, end_index: 10 },
            { type: "url_citation", url: "https://example-news.test/curie", title: "example-news.test" },
            { type: "url_citation", url: "javascript:alert(1)", title: "bad" },
          ],
        },
      ],
    },
  ],
};

describe("источники из grounding", () => {
  test("берутся только url_citation с http(s), дубликаты схлопываются", () => {
    const citations = extractCitations(SYNTHETIC);
    expect(citations.map((c) => c.url)).toEqual([
      "https://www.nobelprize.org/prizes/physics/1903/marie-curie/biographical/",
      "https://example-news.test/curie",
    ]);
    expect(citations[0]!.citedText).toBe("Мария Кюри родилась 7 ноября 1867 года в Варшаве");
    expect(citations[1]!.annotationIndex).toBe(2);
  });

  const base = { interactionId: "int-test-1", retrievedAt: "2026-10-25T12:00:00Z", articleUrl: "https://example-news.test/article" };

  test("supported без источника из grounding понижается до insufficient", () => {
    const d = decideVerdict({ ...base, verdict: "supported", explanation: "Да", sources: [{ index: 7 }], citations: extractCitations(SYNTHETIC) });
    expect(d.verdict).toBe("insufficient");
    expect(d.evidence).toEqual([]);
    expect(d.downgraded).not.toBeNull();
  });

  test("ссылка на сайт самой статьи не считается подтверждением", () => {
    const d = decideVerdict({ ...base, verdict: "contradicted", explanation: "Нет", sources: [{ index: 2, role: "secondary" }], citations: extractCitations(SYNTHETIC) });
    expect(d.verdict).toBe("insufficient");
  });

  test("источник сохраняет ссылку на аннотацию и роль", () => {
    const d = decideVerdict({
      ...base,
      verdict: "supported",
      explanation: "Подтверждается биографией на сайте Нобелевского комитета.",
      sources: [{ index: 1, role: "primary", relation: "Биография лауреата" }],
      citations: extractCitations(SYNTHETIC),
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
