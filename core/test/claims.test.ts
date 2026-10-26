import { describe, expect, test } from "vitest";
import type { Block } from "../../shared/contract.ts";
import { chunkBlocks, mergeDuplicates, restrictToFocus, validateClaims } from "../claims.ts";

const blocks: Block[] = [
  { id: "b1", type: "title", order: 1, text: "Путин сделал заявление о беспорядках в ЕС", links: [] },
  { id: "b2", type: "subtitle", order: 2, text: "Путина удивило, что политики ЕС начали обвинять США в организации беспорядков", links: [] },
  {
    id: "b3",
    type: "paragraph",
    order: 3,
    text: "Президента России Владимира Путина удивило, что политики Европейского союза (ЕС) начали обвинять США в организации беспорядков. Об этом он рассказал в интервью журналисту Павлу Зарубину.",
    links: [],
  },
  { id: "b4", type: "caption", order: 4, text: "Фото: Михаил Метцель / РИА Новости", links: [] },
];

describe("проверка ответа модели", () => {
  test("отбрасывает несуществующие blockId, выдуманные фрагменты и подписи к фото", () => {
    const report = validateClaims(
      [
        { occurrences: [{ blockId: "b99", exactText: "чего нет в статье" }], normalizedClaim: "Выдумка", kind: "event", isOpinion: false },
        { occurrences: [{ blockId: "b4", exactText: "Михаил Метцель" }], normalizedClaim: "Фото сделал Михаил Метцель", kind: "other", isOpinion: false },
        {
          occurrences: [{ blockId: "b3", exactText: "Об этом он рассказал в интервью журналисту Павлу Зарубину" }],
          normalizedClaim: "Путин рассказал об этом в интервью Павлу Зарубину",
          kind: "attribution",
          isOpinion: false,
        },
      ],
      blocks,
    );
    expect(report.rejected).toBe(2);
    expect(report.claims).toHaveLength(1);
    expect(report.claims[0]!.occurrences).toEqual([{ blockId: "b3", exactText: "Об этом он рассказал в интервью журналисту Павлу Зарубину" }]);
  });

  test("находит фрагмент с другим регистром и пробелами и возвращает точный текст блока", () => {
    const report = validateClaims(
      [{ occurrences: [{ blockId: "b2", exactText: "путина  удивило, что политики ЕС" }], normalizedClaim: "x", kind: "other", isOpinion: false }],
      blocks,
    );
    expect(report.claims[0]!.occurrences[0]!.exactText).toBe("Путина удивило, что политики ЕС");
  });

  test("перепривязывает фрагмент к блоку, где он однозначно найден", () => {
    const report = validateClaims(
      [{ occurrences: [{ blockId: "b1", exactText: "журналисту Павлу Зарубину" }], normalizedClaim: "x", kind: "other", isOpinion: false }],
      blocks,
    );
    expect(report.reassignedOccurrences).toBe(1);
    expect(report.claims[0]!.occurrences[0]!.blockId).toBe("b3");
  });
});

test("дубликаты из подзаголовка и абзаца объединяются в один claim с двумя блоками", () => {
  const { claims } = validateClaims(
    [
      {
        occurrences: [{ blockId: "b3", exactText: "политики Европейского союза (ЕС) начали обвинять США в организации беспорядков" }],
        normalizedClaim: "Политики ЕС начали обвинять США в организации беспорядков в странах ЕС",
        kind: "event",
        isOpinion: false,
      },
      {
        occurrences: [{ blockId: "b2", exactText: "политики ЕС начали обвинять США в организации беспорядков" }],
        normalizedClaim: "Политики ЕС начали обвинять США в организации беспорядков в странах ЕС.",
        kind: "event",
        isOpinion: true,
      },
    ],
    blocks,
  );
  const merged = mergeDuplicates(claims, blocks);
  expect(merged).toHaveLength(1);
  expect(merged[0]!.occurrences.map((o) => o.blockId)).toEqual(["b2", "b3"]);
  expect(merged[0]!.isOpinion).toBe(false);
});

test("длинная статья делится на части с перекрытием в один блок", () => {
  const many: Block[] = Array.from({ length: 5 }, (_, i) => ({ id: `b${i + 1}`, type: "paragraph", order: i + 1, text: "x".repeat(400), links: [] }));
  const chunks = chunkBlocks(many, 1000);
  expect(chunks.map((c) => c.map((b) => b.id))).toEqual([["b1", "b2"], ["b2", "b3"], ["b3", "b4"], ["b4", "b5"]]);
});

describe("разные факты не склеиваются", () => {
  const actor: Block[] = [
    { id: "b1", type: "subtitle", order: 1, text: "Актер театра «Чеховская студия» Владимир Курочкин умер на 42-м году жизни", links: [] },
    { id: "b2", type: "paragraph", order: 2, text: "Владимир Курочкин родился 20 декабря 1984 года. Он снялся в фильме «Все по закону».", links: [] },
  ];

  test("фрагмент с чужими числами не привязывается к утверждению", () => {
    const { claims } = validateClaims(
      [
        {
          occurrences: [
            { blockId: "b1", exactText: "Актер театра «Чеховская студия» Владимир Курочкин" },
            { blockId: "b2", exactText: "Владимир Курочкин родился 20 декабря 1984 года." },
          ],
          normalizedClaim: "Владимир Курочкин был актером театра «Чеховская студия»",
          kind: "event",
          isOpinion: false,
        },
      ],
      actor,
    );
    expect(claims[0]!.occurrences.map((o) => o.blockId)).toEqual(["b1"]);
  });

  test("общий фрагмент не объединяет утверждения о разных фактах", () => {
    const fragment = { blockId: "b2", exactText: "Владимир Курочкин родился 20 декабря 1984 года." };
    const { claims } = validateClaims(
      [
        { occurrences: [fragment], normalizedClaim: "Владимир Курочкин родился 20 декабря 1984 года", kind: "date", isOpinion: false },
        { occurrences: [fragment], normalizedClaim: "Курочкин был актером театра «Чеховская студия»", kind: "event", isOpinion: false },
      ],
      actor,
    );
    expect(mergeDuplicates(claims, actor)).toHaveLength(2);
  });
});

test("поисковые запросы из извлечения очищаются, у мнений отбрасываются, при объединении дубликатов складываются", () => {
  const { claims } = validateClaims(
    [
      { occurrences: [{ blockId: "b2", exactText: "политики ЕС начали обвинять США" }], normalizedClaim: "Политики ЕС начали обвинять США в беспорядках", kind: "event", isOpinion: false, searchQueries: ["  ЕС обвиняет США беспорядки ", "", 42, "ЕС обвиняет США беспорядки"] },
      { occurrences: [{ blockId: "b3", exactText: "политики Европейского союза (ЕС) начали обвинять США" }], normalizedClaim: "Политики ЕС начали обвинять США в беспорядках.", kind: "event", isOpinion: false, searchQueries: ["Путин интервью Зарубину ЕС США"] },
      { occurrences: [{ blockId: "b3", exactText: "Об этом он рассказал" }], normalizedClaim: "Это плохо", kind: "other", isOpinion: true, searchQueries: ["не нужен"] },
    ],
    blocks,
  );
  expect(claims[0]!.searchQueries).toEqual(["ЕС обвиняет США беспорядки"]);
  expect(claims[2]!.searchQueries).toEqual([]);
  expect(mergeDuplicates(claims, blocks)[0]!.searchQueries).toEqual(["ЕС обвиняет США беспорядки", "Путин интервью Зарубину ЕС США"]);
});

describe("проверка выделенного фрагмента", () => {
  const draft = (blockId: string, exactText: string) => ({ normalizedClaim: exactText, kind: "other" as const, isOpinion: false, occurrences: [{ blockId, exactText }], searchQueries: [] });

  test("остаются утверждения, пересекающиеся с выделением, даже если оно начинается посреди предложения", () => {
    const focus = { blockIds: ["b3"], text: "удивило, что политики Европейского союза (ЕС) начали обвинять США в организации беспорядков" };
    const kept = restrictToFocus(
      [
        draft("b3", "Президента России Владимира Путина удивило, что политики Европейского союза (ЕС) начали обвинять США в организации беспорядков."),
        draft("b3", "Об этом он рассказал в интервью журналисту Павлу Зарубину."),
        draft("b2", "Путина удивило, что политики ЕС начали обвинять США в организации беспорядков"),
      ],
      focus,
    );
    expect(kept.map((c) => c.occurrences[0]!.blockId + ":" + c.occurrences[0]!.exactText.slice(0, 20))).toEqual(["b3:Президента России Вл"]);
  });
});
