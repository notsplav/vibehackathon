// Этап B: источники берутся только из аннотаций grounding (url_citation) ответа Gemini,
// а не из текста модели. Вердикт без источника понижается до insufficient (ТЗ 12, п. 5).

import type { Evidence, Verdict } from "../../../shared/contract.ts";

/** Минимальная форма ответа Interactions API, которую мы читаем (по типам @google/genai). */
export interface InteractionLike {
  id?: string;
  steps?: unknown[];
  output_text?: string;
}

export interface Citation {
  url: string;
  title: string | null;
  /** Порядковый номер аннотации в ответе — ссылка на исходную аннотацию Gemini. */
  annotationIndex: number;
  /** Фрагмент ответа модели, к которому относится ссылка. */
  citedText: string | null;
}

interface TextContentLike {
  type?: string;
  text?: string;
  annotations?: { type?: string; url?: string; title?: string; start_index?: number; end_index?: number }[];
}

/** Все url_citation из шагов model_output; дубликаты URL схлопываются, первая аннотация сохраняется. */
export function extractCitations(interaction: InteractionLike): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const step of interaction.steps ?? []) {
    const s = step as { type?: string; content?: TextContentLike[] };
    if (s?.type !== "model_output" || !Array.isArray(s.content)) continue;
    for (const content of s.content) {
      for (const a of content.annotations ?? []) {
        const current = index++;
        if (a?.type !== "url_citation" || typeof a.url !== "string" || !/^https?:\/\//i.test(a.url)) continue;
        if (seen.has(a.url)) continue;
        seen.add(a.url);
        const text = content.text ?? "";
        const cited =
          typeof a.start_index === "number" && typeof a.end_index === "number" && a.end_index > a.start_index
            ? text.slice(a.start_index, a.end_index)
            : null;
        out.push({ url: a.url, title: a.title?.trim() || null, annotationIndex: current, citedText: cited });
      }
    }
  }
  return out;
}

/** Текст ответа модели из шагов model_output (или output_text). */
export function outputText(interaction: InteractionLike): string {
  if (interaction.output_text) return interaction.output_text;
  const parts: string[] = [];
  for (const step of interaction.steps ?? []) {
    const s = step as { type?: string; content?: TextContentLike[] };
    if (s?.type !== "model_output") continue;
    for (const c of s.content ?? []) if (c.type === "text" && c.text) parts.push(c.text);
  }
  return parts.join("\n");
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
 * Некоторые ссылки grounding — редиректы Google; тогда домен источника берётся из title, если он похож на домен.
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
 * Собирает итог проверки. Ссылки — только из `citations` (grounding); модель может лишь указать номера
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
    downgraded = `Вердикт «${verdict}» без источника из grounding заменён на insufficient`;
    verdict = "insufficient";
  }
  return { verdict, explanation: input.explanation, evidence, downgraded };
}
