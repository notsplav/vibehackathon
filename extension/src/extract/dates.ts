// Даты публикации и обновления (ТЗ 5.1, п. 3). Дата события в тексте, дата из URL и текущая дата не используются.

import type { SourcedValue } from "../../../shared/contract.ts";
import { isInExcludedRegion } from "./regions.ts";
import { isHiddenDeep, normalizeSpace, visibleText } from "./text.ts";

const MONTHS: Record<string, number> = {
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};

/** Дата и время «как на стене», без часового пояса. Поля, которых нет в тексте, равны null. */
export interface WallTime {
  year: number | null;
  month: number;
  day: number;
  hour: number | null;
  minute: number | null;
}

const TIME = String.raw`(\d{1,2})[:.](\d{2})`;
const RU_DATE = String.raw`(\d{1,2})\s+(янв\S*|фев\S*|мар\S*|апр\S*|ма[яй]\S*|июн\S*|июл\S*|авг\S*|сен\S*|окт\S*|ноя\S*|дек\S*)(?:\s+(\d{4}))?(?:\s*(?:г\.|года?))?`;
const NUM_DATE = String.raw`(\d{1,2})\.(\d{1,2})\.(\d{4})`;

/** Все видимые даты в строке: «12:16, 25 октября 2026», «25 октября 2026, 12:16», «25.10.2026 12:16». */
export function parseVisibleDates(text: string): WallTime[] {
  const s = normalizeSpace(text).toLowerCase();
  const out: WallTime[] = [];
  const patterns: [RegExp, (m: RegExpExecArray) => WallTime | null][] = [
    [new RegExp(`${TIME},?\\s+${RU_DATE}`, "gu"), (m) => ru(m[3]!, m[4]!, m[5], m[1], m[2])],
    [new RegExp(`${RU_DATE},?\\s*(?:в\\s+)?${TIME}`, "gu"), (m) => ru(m[1]!, m[2]!, m[3], m[4], m[5])],
    [new RegExp(RU_DATE, "gu"), (m) => ru(m[1]!, m[2]!, m[3], undefined, undefined)],
    [new RegExp(`${NUM_DATE}(?:,?\\s+${TIME})?`, "gu"), (m) => num(m[1]!, m[2]!, m[3]!, m[4], m[5])],
  ];
  const taken: [number, number][] = [];
  for (const [re, build] of patterns) {
    for (let m = re.exec(s); m; m = re.exec(s)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      const wt = build(m);
      if (wt) {
        out.push(wt);
        taken.push([start, end]);
      }
    }
  }
  return out;
}

function ru(day: string, month: string, year?: string, hour?: string, minute?: string): WallTime | null {
  const mon = MONTHS[month.slice(0, 3)];
  if (!mon) return null;
  return make(+day, mon, year ? +year : null, hour, minute);
}

function num(day: string, month: string, year: string, hour?: string, minute?: string): WallTime | null {
  return make(+day, +month, +year, hour, minute);
}

function make(day: number, month: number, year: number | null, hour?: string, minute?: string): WallTime | null {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  const h = hour !== undefined ? +hour : null;
  const mi = minute !== undefined ? +minute : null;
  if (h !== null && (h > 23 || mi === null || mi > 59)) return null;
  return { year, month, day, hour: h, minute: mi };
}

/** Местное время из ISO-строки (до приведения к UTC): так оно совпадает с подписью на странице. */
export function isoWallTime(iso: string): WallTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso.trim());
  if (!m) return null;
  return { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: m[4] ? +m[4] : null, minute: m[5] ? +m[5] : null };
}

/**
 * Совпадают ли дата из разметки и видимая дата с точностью до минуты (если видимое время указано).
 * Разметка часто хранит время в UTC, а страница показывает местное, поэтому при указанном времени
 * допускается сдвиг на целое число часов (часовой пояс) при совпадении минут.
 */
export function wallTimesMatch(structured: WallTime, visible: WallTime): boolean {
  if (visible.hour === null) {
    if (structured.day !== visible.day || structured.month !== visible.month) return false;
    return visible.year === null || structured.year === visible.year;
  }
  if (structured.hour === null || structured.year === null || structured.minute !== visible.minute) return false;
  const year = visible.year ?? structured.year;
  const a = Date.UTC(structured.year, structured.month - 1, structured.day, structured.hour, structured.minute ?? 0);
  const b = Date.UTC(year, visible.month - 1, visible.day, visible.hour, visible.minute ?? 0);
  const shiftHours = (b - a) / 3_600_000;
  return Number.isInteger(shiftHours) && shiftHours >= -12 && shiftHours <= 14;
}

export function isValidIso(value: string): boolean {
  return isoWallTime(value) !== null && !Number.isNaN(Date.parse(value));
}

/** Видимые даты из «шапки» статьи: элементов перед заголовком и рядом с ним, вне служебных областей. */
export function visibleHeaderDates(doc: Document, anchors: Element[]): { el: Element; text: string; dates: WallTime[] }[] {
  const results: { el: Element; text: string; dates: WallTime[] }[] = [];
  const seen = new Set<Element>();
  const scope = headerScope(anchors);
  const candidates = scope
    ? Array.from(scope.querySelectorAll("time, a, span, div, p, li"))
    : Array.from(doc.querySelectorAll("time"));
  for (const el of candidates) {
    if (seen.has(el)) continue;
    // Берём самый вложенный элемент с датой: у него нет дочерних элементов с собственным текстом-датой.
    if (el.children.length > 0 && el.tagName !== "TIME" && Array.from(el.children).some((c) => /\d/.test(c.textContent ?? ""))) continue;
    if (isInExcludedRegion(el) || isHiddenDeep(el) || insideCard(el, anchors)) continue;
    const text = visibleText(el);
    if (text.length === 0 || text.length > 120) continue;
    const dates = parseVisibleDates(text);
    if (dates.length > 0) {
      seen.add(el);
      results.push({ el, text, dates });
    }
  }
  return results;
}

/** Ближайший общий предок заголовка и тела статьи, поднятый на один уровень: там обычно лежит шапка с датой. */
function headerScope(anchors: Element[]): Element | null {
  const present = anchors.filter(Boolean);
  if (present.length === 0) return null;
  let common: Element | null = present[0]!;
  for (const a of present.slice(1)) {
    while (common && !common.contains(a)) common = common.parentElement;
  }
  // Шапка с датой бывает соседом контейнера статьи (как на Lenta.ru), поэтому поднимаемся ещё на два уровня.
  for (let i = 0; i < 2 && common?.parentElement && common.parentElement.tagName !== "BODY"; i++) common = common.parentElement;
  return common;
}

/** Время в карточке другой статьи (ссылка на другую страницу с заголовком) не относится к публикации. */
function insideCard(el: Element, anchors: Element[]): boolean {
  const link = el.closest("a[href]");
  if (!link) return false;
  if (anchors.some((a) => a.contains(link))) return false;
  return (link.textContent ?? "").replace(/[\d\s:.,]/g, "").length > 40;
}

export interface DateResolution {
  publishedAt: SourcedValue<string> | null;
  modifiedAt: SourcedValue<string> | null;
  warnings: string[];
}

export interface DateInputs {
  jsonldPublished: string | null;
  jsonldModified: string | null;
  doc: Document;
  /** Заголовок и корень тела статьи — опорные элементы для поиска видимой даты. */
  anchors: Element[];
}

const PUBLISHED_META = ["article:published_time", "og:article:published_time", "datePublished", "pubdate", "publishdate"];
const MODIFIED_META = ["article:modified_time", "og:updated_time", "dateModified"];

function metaContent(doc: Document, names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`);
    const value = el?.getAttribute("content")?.trim();
    if (value) return { name, value };
  }
  return null;
}

export function resolveDates(input: DateInputs): DateResolution {
  const warnings: string[] = [];
  const visible = visibleHeaderDates(input.doc, input.anchors);
  const visibleDates = visible.flatMap((v) => v.dates);
  const modifiedHint = (v: { text: string }) => /обновлен|изменен|updated|modified/i.test(v.text);

  const confirm = (iso: string): boolean => {
    const wt = isoWallTime(iso);
    return !!wt && visibleDates.some((v) => wallTimesMatch(wt, v));
  };

  const pick = (
    jsonld: string | null,
    jsonldSource: string,
    meta: { name: string; value: string } | null,
    kind: "published" | "modified",
  ): SourcedValue<string> | null => {
    if (jsonld && !isValidIso(jsonld)) {
      warnings.push(`${jsonldSource}: некорректная дата «${jsonld}»`);
      jsonld = null;
    }
    if (jsonld) {
      const ok = confirm(jsonld);
      if (!ok && visibleDates.length > 0 && kind === "published") warnings.push(`${jsonldSource} не совпадает с видимой датой`);
      return { value: jsonld, source: jsonldSource, quality: ok ? "confirmed" : "plausible" };
    }
    if (meta && isValidIso(meta.value)) {
      return { value: meta.value, source: `meta.${meta.name}`, quality: confirm(meta.value) ? "confirmed" : "plausible" };
    }
    return null;
  };

  let publishedAt = pick(input.jsonldPublished, "jsonld.datePublished", metaContent(input.doc, PUBLISHED_META), "published");
  const modifiedAt = pick(input.jsonldModified, "jsonld.dateModified", metaContent(input.doc, MODIFIED_META), "modified");

  if (!publishedAt) {
    // <time datetime> рядом с заголовком: часы сайта без datetime сюда не попадают.
    const time = visible.find((v) => v.el.tagName === "TIME" && v.el.getAttribute("datetime") && !modifiedHint(v));
    const dt = time?.el.getAttribute("datetime")?.trim();
    if (time && dt && isValidIso(dt)) {
      // Атрибут сверяется с видимым текстом того же элемента.
      const wt = isoWallTime(dt);
      const ok = !!wt && time.dates.some((d) => wallTimesMatch(wt, d));
      publishedAt = { value: dt, source: "dom.time[datetime]", quality: ok ? "confirmed" : "plausible" };
    } else {
      // Явная видимая подпись с полной датой: без часового пояса, поэтому только «правдоподобно».
      const label = visible.find((v) => !modifiedHint(v) && v.dates.some((d) => d.year !== null));
      const d = label?.dates.find((x) => x.year !== null);
      if (d) {
        const pad = (n: number) => String(n).padStart(2, "0");
        const value = `${d.year}-${pad(d.month)}-${pad(d.day)}${d.hour !== null ? `T${pad(d.hour)}:${pad(d.minute ?? 0)}` : ""}`;
        publishedAt = { value, source: "dom.visibleDate", quality: "plausible" };
      }
    }
  }
  return { publishedAt, modifiedAt, warnings };
}
