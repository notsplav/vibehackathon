// Нормализация строк, общая для расширения и сервера. Без DOM.

/** Схлопывает пробельные символы (включая неразрывный пробел) в один пробел. */
export function normalizeSpace(text: string): string {
  return text.replace(/[\s ​⁠﻿]+/g, " ").trim();
}

/**
 * Посимвольная (длина не меняется) нормализация для поиска фрагмента: регистр, «ё», кавычки, тире.
 * Индекс найденного фрагмента совпадает с индексом в исходной строке.
 */
export function foldChars(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»„“”‘’'`]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-");
}

/** Нормализация для сравнения строк: пробелы, регистр, «ё», кавычки, тире и концевая пунктуация. */
export function normalizeForMatch(text: string): string {
  return normalizeSpace(text)
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»„“”"‘’'`]/g, "")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[\s.,:;!?…]+$/u, "");
}

/** Сходство двух строк по множеству слов (коэффициент Жаккара). */
export function wordSimilarity(a: string, b: string): number {
  const wa = new Set(normalizeForMatch(a).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const wb = new Set(normalizeForMatch(b).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common);
}
