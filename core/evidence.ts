// Этап B: источники берутся только из результатов поиска (инструмента WebSearch), а не из текста модели.
// Вердикт без источника понижается до insufficient (ТЗ 12, п. 5).

import type { Evidence, Verdict } from "../shared/contract.ts";

export interface Citation {
  url: string;
  title: string | null;
  /** Порядковый номер результата поиска — ссылка на исходные данные поиска. */
  annotationIndex: number;
  /** Фрагмент найденной страницы, если поиск его вернул. */
  citedText: string | null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Источник с того же сайта, что и проверяемая статья, не считается независимым подтверждением.
 * Если ссылка — редирект поисковика, домен источника берётся из title, если он похож на домен.
 */
export function isSameSite(citation: Citation, articleUrl: string): boolean {
  const article = hostOf(articleUrl);
  if (!article) return false;
  const host = hostOf(citation.url);
  const candidates = [host, citation.title?.toLowerCase().replace(/^www\./, "") ?? null];
  return candidates.some((h) => !!h && (h === article || h.endsWith(`.${article}`)));
}

export interface SourceAssessment {
  /** Номер источника в списке, переданном модели (с 1). */
  index: number;
  role?: unknown;
  relation?: unknown;
}

export interface VerdictDecision {
  verdict: Verdict;
  explanation: string;
  evidence: Evidence[];
  /** Почему вердикт модели был изменён сервером. */
  downgraded: string | null;
}

const ROLES = ["primary", "secondary", "unknown"] as const;

/**
 * Собирает итог проверки. Ссылки — только из `citations` (результаты поиска); модель может лишь указать номера
 * и роль источников. Любой вердикт, кроме `insufficient`, без хотя бы одного такого источника становится `insufficient`.
 */
export function decideVerdict(input: {
  verdict: Verdict;
  explanation: string;
  sources: SourceAssessment[];
  citations: Citation[];
  interactionId: string | null;
  retrievedAt: string;
  /** URL проверяемой статьи: ссылки на тот же сайт не считаются свидетельствами. */
  articleUrl: string;
  maxSources?: number;
}): VerdictDecision {
  const evidence: Evidence[] = [];
  const used = new Set<number>();
  for (const s of input.sources) {
    const citation = Number.isInteger(s.index) ? input.citations[s.index - 1] : undefined;
    if (!citation || used.has(s.index) || isSameSite(citation, input.articleUrl)) continue;
    used.add(s.index);
    evidence.push({
      url: citation.url,
      title: citation.title,
      retrievedAt: input.retrievedAt,
      role: ROLES.includes(s.role as (typeof ROLES)[number]) ? (s.role as Evidence["role"]) : "unknown",
      relation: typeof s.relation === "string" && s.relation.trim() ? s.relation.trim().slice(0, 300) : null,
      grounding: { interactionId: input.interactionId, annotationIndex: citation.annotationIndex },
    });
    if (evidence.length >= (input.maxSources ?? 3)) break;
  }

  let verdict = input.verdict;
  let downgraded: string | null = null;
  if ((verdict === "supported" || verdict === "contradicted" || verdict === "qualified" || verdict === "disputed") && evidence.length === 0) {
    downgraded = `Вердикт «${verdict}» без источника из поиска заменён на insufficient`;
    verdict = "insufficient";
  }
  return { verdict, explanation: input.explanation, evidence, downgraded };
}
