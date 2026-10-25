// Наглядный ход анализа: шаги этапов, текущее действие, полоса по вердиктам, таймеры и оценка времени.
// Всё строится через textContent; время обновляется тикером по атрибутам data-since / data-ago.

import type { AnalysisState, CheckStep, Claim } from "../../../shared/contract.ts";
import { VERDICTS } from "../../../shared/contract.ts";
import { LABELS } from "../labels.ts";

export type StepState = "done" | "active" | "pending" | "error" | "skipped";

export interface Stage {
  title: string;
  state: StepState;
  detail: string | null;
}

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

const STEP_TEXT: Record<CheckStep, string> = {
  queries: "составляем поисковые запросы",
  search: "ищем источники",
  verdict: "сравниваем источники и выносим вердикт",
};

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Оценка оставшегося времени по интервалам между завершёнными проверками; null, если данных мало. */
export function estimateRemainingMs(a: AnalysisState, now: number): number | null {
  const done = a.claims
    .filter((c) => (c.status === "checked" || c.status === "failed") && c.checkedAt)
    .map((c) => Date.parse(c.checkedAt!))
    .sort((x, y) => x - y);
  const remaining = a.stats.total - a.stats.completed;
  if (done.length < 2 || remaining <= 0) return null;
  const perClaim = (done[done.length - 1]! - done[0]!) / (done.length - 1);
  // Текущая проверка уже идёт какое-то время — вычитаем его.
  const runningFor = Math.max(0, ...(a.live?.checking ?? []).map((c) => now - Date.parse(c.since)));
  return Math.max(0, perClaim * remaining - runningFor);
}

export function stages(a: AnalysisState): Stage[] {
  const s = a.stats;
  const extracting = a.status === "queued" || a.status === "extracting_claims";
  const checkedAny = a.claims.some((c) => c.status === "checked");
  const ext = a.live?.extraction;

  const find: Stage = extracting
    ? { title: "Поиск утверждений в тексте", state: a.status === "queued" ? "pending" : "active", detail: ext && ext.total > 1 ? `часть ${Math.min(ext.done + 1, ext.total)} из ${ext.total}` : "модель читает статью" }
    : a.status === "failed" && a.claims.length === 0
      ? { title: "Поиск утверждений в тексте", state: "error", detail: null }
      : { title: "Поиск утверждений в тексте", state: "done", detail: `найдено ${s.total}${s.opinions ? `, мнений ${s.opinions}` : ""}` };

  let check: Stage;
  if (extracting || find.state === "error") check = { title: "Проверка по источникам", state: "pending", detail: null };
  else if (s.total === 0) check = { title: "Проверка по источникам", state: "skipped", detail: "нечего проверять" };
  else if (a.status === "checking") check = { title: "Проверка по источникам", state: "active", detail: `${s.completed} из ${s.total}` };
  else if (a.status === "cancelled") check = { title: "Проверка по источникам", state: "error", detail: `отменена, не проверено ${s.notChecked}` };
  else if (a.error) check = { title: "Проверка по источникам", state: "error", detail: `остановлена: ${s.failed} с ошибкой` };
  else check = { title: "Проверка по источникам", state: "done", detail: `${s.completed} из ${s.total}` };

  let summary: Stage;
  if (a.summary) summary = { title: "Сводка", state: "done", detail: null };
  else if (a.status === "completed" && !a.error && checkedAny) summary = { title: "Сводка", state: a.live ? "active" : "skipped", detail: a.live ? "пишем по результатам" : "не получена" };
  else if (TERMINAL.has(a.status)) summary = { title: "Сводка", state: "skipped", detail: null };
  else summary = { title: "Сводка", state: "pending", detail: null };

  return [{ title: "Статья извлечена со страницы", state: "done", detail: null }, find, check, summary];
}

/** Текст «что происходит сейчас» с пояснением шага; null, если анализ не идёт. */
export function currentActivity(a: AnalysisState): { title: string; items: { text: string; step: string; since: string; queries: string[] }[] } | null {
  if (!a.live) return null;
  if (a.status === "queued" || a.status === "extracting_claims") {
    return { title: "Модель читает статью и выделяет проверяемые утверждения", items: [] };
  }
  if (a.status === "checking" && a.live.checking.length > 0) {
    const byId = new Map(a.claims.map((c) => [c.id, c]));
    return {
      title:
        a.live.checking.length > 1
          ? `Проверяются ${a.live.checking.length} ${plural(a.live.checking.length, "утверждение", "утверждения", "утверждений")}`
          : "Проверяется утверждение",
      items: a.live.checking.map((c) => ({ text: byId.get(c.claimId)?.normalizedClaim ?? c.claimId, step: STEP_TEXT[c.step], since: c.since, queries: c.queries })),
    };
  }
  if (a.status === "completed" && !a.summary) return { title: "Проверки завершены, модель пишет сводку", items: [] };
  return null;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec} с`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Элемент со временем, которое тикер обновляет каждую секунду. */
function timer(since: string, prefix = ""): HTMLElement {
  const el = h("span", "timer");
  el.dataset.since = since;
  el.dataset.prefix = prefix;
  el.textContent = `${prefix}${formatDuration(Date.now() - Date.parse(since))}`;
  return el;
}

export function tick(root: ParentNode, now = Date.now()): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-since]"))) {
    el.textContent = `${el.dataset.prefix ?? ""}${formatDuration(now - Date.parse(el.dataset.since!))}`;
  }
  // Давность последнего ответа сервера — в подсказке плашки; если ответа долго нет, плашка желтеет.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-ago]"))) {
    const sec = Math.round((now - Number(el.dataset.ago)) / 1000);
    el.title = sec < 3 ? "Данные обновлены только что" : `Данные обновлены ${sec} с назад`;
    el.classList.toggle("stale", sec > 10);
  }
}

const ICON: Record<StepState, string> = { done: "✓", active: "", pending: "", error: "!", skipped: "–" };

export function renderProgress(a: AnalysisState, lastPollAt: number | null, actions?: HTMLElement): HTMLElement {
  const section = h("section", "progress");
  const active = !!a.live;

  const head = h("div", "progress-head");
  // Статус и время — в одной плашке: «Анализ идёт · 2:34».
  if (active) {
    const pill = timer(a.createdAt, "Анализ идёт · ");
    pill.className = "status-pill is-active";
    if (lastPollAt) pill.dataset.ago = String(lastPollAt);
    head.append(pill);
  } else {
    head.append(h("span", `status-pill ${a.error || a.status === "cancelled" ? "is-warn" : "is-done"}`, a.status === "cancelled" ? "Отменён" : a.error ? "Остановлен" : "Готово"));
  }
  if (actions) head.append(actions);
  section.append(head);

  // Шаги этапов.
  const list = h("ol", "steps");
  stages(a).forEach((st, i) => {
    const li = h("li", `step step-${st.state}`);
    const marker = h("span", "step-marker", ICON[st.state] || String(i + 1));
    if (st.state === "active") marker.append(h("span", "spinner"));
    li.setAttribute("aria-current", st.state === "active" ? "step" : "false");
    const body = h("div", "step-body");
    body.append(h("div", "step-title", st.title));
    if (st.detail) body.append(h("div", "step-detail", st.detail));
    li.append(marker, body);
    list.append(li);
  });
  section.append(list);

  // Что происходит сейчас.
  const activity = currentActivity(a);
  if (activity) {
    const now = h("div", "now");
    now.setAttribute("role", "status");
    const title = h("div", "now-title");
    title.append(h("span", "spinner"), h("span", undefined, activity.title));
    now.append(title);
    for (const item of activity.items) {
      const row = h("div", "now-item");
      row.append(h("div", "now-claim", `«${item.text}»`));
      const step = h("div", "now-step");
      step.append(h("span", undefined, `${item.step} · `), timer(item.since));
      row.append(step);
      if (item.queries.length) row.append(h("div", "now-queries", `Запросы: ${item.queries.map((q) => `«${q}»`).join(", ")}`));
      now.append(row);
    }
    section.append(now);
  }

  // Полоса: завершённые утверждения цветом вердикта, идущие — штриховкой.
  const s = a.stats;
  if (s.total > 0) {
    const bar = h("div", `bar ${active ? "is-active" : ""}`);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(s.completed));
    bar.setAttribute("aria-valuemax", String(s.total));
    bar.setAttribute("aria-label", `Проверено ${s.completed} из ${s.total}`);
    const seg = (cls: string, n: number) => {
      if (n <= 0) return;
      const el = h("span", `seg ${cls}`);
      el.style.width = `${(n / s.total) * 100}%`;
      bar.append(el);
    };
    for (const v of VERDICTS) seg(`bg-${v}`, s.byVerdict[v]);
    seg("bg-failed", s.failed);
    seg("bg-checking", a.live?.checking.length ?? 0);
    section.append(bar);

    const caption = h("div", "bar-caption");
    caption.append(h("span", undefined, `Проверено ${s.completed} из ${s.total}`));
    const eta = active ? estimateRemainingMs(a, Date.now()) : null;
    if (eta !== null) caption.append(h("span", "muted", ` · осталось примерно ${formatDuration(eta)}`));
    section.append(caption);

    const dist = h("ul", "dist");
    for (const v of VERDICTS) if (s.byVerdict[v]) dist.append(h("li", `s-${v}`, `${LABELS[v].icon} ${LABELS[v].text}: ${s.byVerdict[v]}`));
    if (s.failed) dist.append(h("li", "s-failed", `${LABELS.failed.icon} ${LABELS.failed.text}: ${s.failed}`));
    if (s.notChecked) dist.append(h("li", "s-not_checked", `${LABELS.not_checked.icon} ${LABELS.not_checked.text}: ${s.notChecked}`));
    const waiting = s.total - s.completed - (a.live?.checking.length ?? 0) - s.notChecked;
    if (active && waiting > 0) dist.append(h("li", "s-queued", `${LABELS.queued.icon} ${LABELS.queued.text}: ${waiting}`));
    if (dist.childElementCount) section.append(dist);
  }

  if (a.error) section.append(h("p", "error", a.error));
  if (a.summary) {
    const box = h("div", "summary");
    box.append(h("h3", undefined, "Сводка"), h("p", undefined, a.summary));
    section.append(box);
  }
  tick(section);
  return section;
}

/** Шаг проверки для элемента списка утверждений, если оно проверяется сейчас. */
export function liveStep(a: AnalysisState, claim: Claim): string | null {
  const c = a.live?.checking.find((x) => x.claimId === claim.id);
  return c ? STEP_TEXT[c.step] : null;
}
