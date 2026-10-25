// Этап A: подготовка блоков для Gemini, проверка ответа и объединение дубликатов (ТЗ 6.2, 7).
// Ответ модели — недоверенные данные: каждый blockId и фрагмент проверяются по сохранённым блокам.

import type { Block, ClaimKind, ClaimOccurrence } from "../../../shared/contract.ts";
import { foldChars, normalizeForMatch, normalizeSpace, wordSimilarity } from "../../../shared/text.ts";

const KINDS: ClaimKind[] = ["event", "date", "number", "quote", "attribution", "other"];
const DUPLICATE_SIMILARITY = 0.85;
/** Общий фрагмент — повод объединить только похожие по смыслу формулировки, а не любые две. */
const SHARED_FRAGMENT_SIMILARITY = 0.6;

/** Блоки, из которых выделяются утверждения. Подписи к фото по умолчанию не проверяются (ТЗ 5.3). */
export function checkableBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => b.type !== "caption" && b.text.trim().length > 0);
}

/**
 * Делит статью на части не длиннее `maxChars`. Соседние части перекрываются одним блоком,
 * чтобы утверждение на границе не потерялось; дубликаты потом объединяются.
 */
export function chunkBlocks(blocks: Block[], maxChars: number): Block[][] {
  const chunks: Block[][] = [];
  let current: Block[] = [];
  let size = 0;
  for (const b of blocks) {
    if (current.length > 0 && size + b.text.length > maxChars) {
      chunks.push(current);
      const overlap = current[current.length - 1]!;
      current = [overlap];
      size = overlap.text.length;
    }
    current.push(b);
    size += b.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Утверждение в том виде, в каком его возвращает модель (до проверки). */
export interface RawClaim {
  occurrences?: { blockId?: unknown; exactText?: unknown }[];
  normalizedClaim?: unknown;
  kind?: unknown;
  isOpinion?: unknown;
  /** Поисковые запросы, составленные вместе с утверждением (провайдер Ollama). */
  searchQueries?: unknown;
}

export interface DraftClaim {
  normalizedClaim: string;
  kind: ClaimKind;
  isOpinion: boolean;
  occurrences: ClaimOccurrence[];
  searchQueries: string[];
}

const MAX_SEARCH_QUERIES = 5;

/** Только непустые строки разумной длины, без повторов. */
export function cleanQueries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const q of raw) {
    if (typeof q !== "string") continue;
    const v = normalizeSpace(q).slice(0, 300);
    if (v.length > 2 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    if (out.length >= MAX_SEARCH_QUERIES) break;
  }
  return out;
}

export interface ValidationReport {
  claims: DraftClaim[];
  /** Сколько утверждений отброшено целиком, потому что ни один фрагмент не найден в тексте. */
  rejected: number;
  /** Сколько отдельных вхождений отброшено или перепривязано к другому блоку. */
  droppedOccurrences: number;
  reassignedOccurrences: number;
}

/** Ищет фрагмент в тексте блока после безопасной нормализации и возвращает точный фрагмент блока. */
export function locate(blockText: string, fragment: string): string | null {
  const needle = foldChars(normalizeSpace(fragment));
  if (needle.length < 3) return null;
  const hay = foldChars(blockText);
  let i = hay.indexOf(needle);
  // Модель иногда добавляет точку в конце фрагмента.
  let len = needle.length;
  if (i < 0 && /[.…]$/.test(needle)) {
    const trimmed = needle.replace(/[.…]+$/, "");
    i = hay.indexOf(trimmed);
    len = trimmed.length;
  }
  return i < 0 ? null : blockText.slice(i, i + len);
}

export function validateClaims(raw: RawClaim[], blocks: Block[]): ValidationReport {
  const byId = new Map(checkableBlocks(blocks).map((b) => [b.id, b]));
  const report: ValidationReport = { claims: [], rejected: 0, droppedOccurrences: 0, reassignedOccurrences: 0 };

  for (const r of raw) {
    const normalizedClaim = typeof r.normalizedClaim === "string" ? normalizeSpace(r.normalizedClaim) : "";
    const occurrences: ClaimOccurrence[] = [];
    for (const o of Array.isArray(r.occurrences) ? r.occurrences : []) {
      if (typeof o?.exactText !== "string") {
        report.droppedOccurrences++;
        continue;
      }
      const block = typeof o.blockId === "string" ? byId.get(o.blockId) : undefined;
      const found = block ? locate(block.text, o.exactText) : null;
      if (block && found) {
        occurrences.push({ blockId: block.id, exactText: found });
        continue;
      }
      // Неверный blockId: принимаем, только если фрагмент однозначно находится в одном другом блоке.
      const elsewhere = [...byId.values()].flatMap((b) => {
        const f = locate(b.text, o.exactText as string);
        return f ? [{ blockId: b.id, exactText: f }] : [];
      });
      if (elsewhere.length === 1) {
        occurrences.push(elsewhere[0]!);
        report.reassignedOccurrences++;
      } else {
        report.droppedOccurrences++;
      }
    }
    if (!normalizedClaim || occurrences.length === 0) {
      report.rejected++;
      continue;
    }
    report.claims.push({
      normalizedClaim,
      kind: KINDS.includes(r.kind as ClaimKind) ? (r.kind as ClaimKind) : "other",
      isOpinion: r.isOpinion === true,
      occurrences: relevantOccurrences(normalizedClaim, uniqueOccurrences(occurrences), report),
      searchQueries: r.isOpinion === true ? [] : cleanQueries(r.searchQueries),
    });
  }
  return report;
}

/** Числа и даты из текста: «20 декабря 1984» → ["20", "1984"]. */
function numbers(text: string): string[] {
  return text.match(/\d+(?:[.,]\d+)?/g) ?? [];
}

/**
 * Модель иногда привязывает к утверждению фрагмент о другом факте (например, дату рождения к «был актёром»).
 * Фрагмент с числами, которых нет в утверждении, отбрасывается; первое вхождение остаётся, если других нет.
 */
function relevantOccurrences(claim: string, list: ClaimOccurrence[], report: ValidationReport): ClaimOccurrence[] {
  const claimNumbers = new Set(numbers(claim));
  const kept = list.filter((o) => numbers(o.exactText).every((n) => claimNumbers.has(n)));
  report.droppedOccurrences += list.length - Math.max(kept.length, 1);
  return kept.length > 0 ? kept : list.slice(0, 1);
}

function uniqueOccurrences(list: ClaimOccurrence[]): ClaimOccurrence[] {
  const seen = new Set<string>();
  return list.filter((o) => {
    const key = `${o.blockId}\u0000${o.exactText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Объединяет дубликаты (например, из заголовка, подзаголовка и абзаца) в один claim с несколькими вхождениями.
 * Если хотя бы один дубликат — факт, объединённое утверждение проверяется как факт.
 */
export function mergeDuplicates(claims: DraftClaim[], blocks: Block[]): DraftClaim[] {
  const merged: DraftClaim[] = [];
  for (const c of claims) {
    const key = normalizeForMatch(c.normalizedClaim);
    const same = merged.find(
      (m) =>
        normalizeForMatch(m.normalizedClaim) === key ||
        wordSimilarity(m.normalizedClaim, c.normalizedClaim) >= DUPLICATE_SIMILARITY ||
        (wordSimilarity(m.normalizedClaim, c.normalizedClaim) >= SHARED_FRAGMENT_SIMILARITY &&
          m.occurrences.some((o) => c.occurrences.some((p) => p.blockId === o.blockId && p.exactText === o.exactText))),
    );
    if (same) {
      same.occurrences = uniqueOccurrences([...same.occurrences, ...c.occurrences]);
      same.searchQueries = cleanQueries([...same.searchQueries, ...c.searchQueries]);
      same.isOpinion = same.isOpinion && c.isOpinion;
    } else {
      merged.push({ ...c, occurrences: [...c.occurrences], searchQueries: [...c.searchQueries] });
    }
  }
  // Порядок чтения: по первому вхождению.
  const order = new Map(blocks.map((b) => [b.id, b.order]));
  const position = (c: DraftClaim) => {
    const first = c.occurrences.reduce((a, b) => ((order.get(a.blockId) ?? 0) <= (order.get(b.blockId) ?? 0) ? a : b));
    const block = blocks.find((b) => b.id === first.blockId);
    return (order.get(first.blockId) ?? 0) * 1e6 + (block ? block.text.indexOf(first.exactText) : 0);
  };
  for (const c of merged) c.occurrences.sort((a, b) => (order.get(a.blockId) ?? 0) - (order.get(b.blockId) ?? 0));
  return merged.sort((a, b) => position(a) - position(b));
}
