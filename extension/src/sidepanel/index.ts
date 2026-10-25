// Боковая панель: запуск анализа, прогресс, список утверждений, сводка и ошибки.
// Прогресс хранится на сервере; панель запоминает только analysisId для URL вкладки и восстанавливается по нему.

import type { AnalysisState, ArticleMetadata, Claim, ExtractedArticle, SourcedValue } from "../../../shared/contract.ts";
import { VERDICTS } from "../../../shared/contract.ts";
import { LABELS, displayState } from "../labels.ts";
import type { ExtractReply, PanelMessage, RenderReply } from "../messages.ts";
import { ApiError, api } from "./api.ts";

const POLL_MS = 1500;
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

interface Saved {
  analysisId: string;
  fingerprint: string;
}

interface View {
  tabId: number | null;
  url: string | null;
  saved: Saved | null;
  analysis: AnalysisState | null;
  metadata: ArticleMetadata | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  stale: boolean;
  geminiConfigured: boolean | null;
}

const view: View = { tabId: null, url: null, saved: null, analysis: null, metadata: null, busy: null, error: null, notice: null, stale: false, geminiConfigured: null };
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

const root = document.getElementById("app")!;

// --- Связь с вкладкой ---

function storageKey(url: string): string {
  return `analysis:${url.split("#")[0]}`;
}

async function sendToTab<T>(msg: PanelMessage): Promise<T> {
  if (view.tabId === null) throw new Error("Нет активной вкладки");
  return (await chrome.tabs.sendMessage(view.tabId, msg)) as T;
}

async function inject(): Promise<void> {
  if (view.tabId === null) throw new Error("Нет активной вкладки");
  try {
    await chrome.scripting.executeScript({ target: { tabId: view.tabId }, files: ["content.js"] });
  } catch {
    throw new Error("Нет доступа к странице. Откройте статью и нажмите на значок расширения на её вкладке.");
  }
}

async function extract(): Promise<{ article: ExtractedArticle; fingerprint: string }> {
  await inject();
  const reply = await sendToTab<ExtractReply>({ type: "vh:extract" });
  if (!reply?.ok) throw new Error(reply?.error ?? "Не удалось извлечь статью");
  return reply;
}

const EXTRACTION_ERRORS: Record<string, string> = {
  not_article: "Страница не похожа на статью. Оценка не выполнялась.",
  empty_page: "Страница пустая или текст ещё не загрузился.",
  low_confidence: "Не удалось надёжно определить основной текст статьи, поэтому он не отправлен на проверку.",
};

// --- Действия ---

async function init(): Promise<void> {
  const gen = ++generation;
  stopPolling();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  Object.assign(view, { tabId: tab?.id ?? null, url: tab?.url ?? null, saved: null, analysis: null, metadata: null, busy: null, error: null, notice: null, stale: false });
  render();
  api.health().then(
    (h) => ((view.geminiConfigured = h.geminiConfigured), render()),
    () => ((view.geminiConfigured = null), render()),
  );
  if (!view.url) return;
  const key = storageKey(view.url);
  const saved = ((await chrome.storage.local.get(key)) as Record<string, Saved | undefined>)[key] ?? null;
  if (gen !== generation || !saved) return;
  view.saved = saved;
  try {
    view.analysis = await api.get(saved.analysisId);
    view.metadata = view.analysis.metadata;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      await chrome.storage.local.remove(key);
      view.saved = null;
    } else view.error = message(e);
    render();
    return;
  }
  render();
  // Восстанавливаем маркеры: извлечение локальное, на сервер ничего не отправляется.
  try {
    const { fingerprint } = await extract();
    if (fingerprint !== saved.fingerprint) view.stale = true;
    else await pushToPage();
  } catch {
    view.notice = "Маркеры на странице не восстановлены: нажмите на значок расширения на вкладке статьи.";
  }
  render();
  if (view.analysis && !isDone(view.analysis)) schedulePoll(gen);
}

async function analyze(force: boolean): Promise<void> {
  const gen = ++generation;
  stopPolling();
  Object.assign(view, { error: null, notice: null, stale: false, busy: "Извлекаем статью…" });
  render();
  try {
    const { article, fingerprint } = await extract();
    view.metadata = article.metadata;
    if (article.extraction.status !== "ok") {
      view.busy = null;
      view.error = EXTRACTION_ERRORS[article.extraction.error?.code ?? ""] ?? "Не удалось извлечь статью.";
      render();
      return;
    }
    view.busy = `Статья извлечена: блоков ${article.blocks.length}. Отправляем на проверку…`;
    render();
    const created = await api.create(article, force);
    view.saved = { analysisId: created.analysisId, fingerprint };
    await chrome.storage.local.set({ [storageKey(view.url ?? article.url)]: view.saved });
    view.analysis = await api.get(created.analysisId);
    view.busy = null;
    await pushToPage();
    render();
    if (!isDone(view.analysis)) schedulePoll(gen);
  } catch (e) {
    view.busy = null;
    view.error = message(e);
    render();
  }
}

async function cancel(): Promise<void> {
  if (!view.saved) return;
  try {
    view.analysis = await api.cancel(view.saved.analysisId);
    await pushToPage();
  } catch (e) {
    view.error = message(e);
  }
  render();
}

async function removeResult(): Promise<void> {
  if (!view.saved) return;
  stopPolling();
  try {
    await api.remove(view.saved.analysisId);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) {
      view.error = message(e);
      render();
      return;
    }
  }
  if (view.url) await chrome.storage.local.remove(storageKey(view.url));
  await sendToTab({ type: "vh:clear" }).catch(() => undefined);
  Object.assign(view, { saved: null, analysis: null, stale: false, notice: "Локальный результат удалён." });
  render();
}

async function pushToPage(): Promise<void> {
  if (!view.analysis || !view.saved || view.stale) return;
  const reply = await sendToTab<RenderReply>({ type: "vh:render", claims: view.analysis.claims, fingerprint: view.saved.fingerprint }).catch(() => null);
  if (reply?.ok && reply.stale) view.stale = true;
}

/** После завершения проверок сводка появляется не сразу: ждём её ограниченное число опросов. */
const SUMMARY_WAIT_POLLS = 20;
let summaryWaits = 0;

function isDone(a: AnalysisState): boolean {
  if (!TERMINAL.has(a.status) || a.preliminary) {
    summaryWaits = 0;
    return false;
  }
  const expectSummary = a.status === "completed" && !a.error && a.summary === null && a.claims.some((c) => c.status === "checked");
  return !expectSummary || ++summaryWaits > SUMMARY_WAIT_POLLS;
}

function schedulePoll(gen: number): void {
  stopPolling();
  pollTimer = setTimeout(async () => {
    if (gen !== generation || !view.saved) return;
    try {
      const next = await api.get(view.saved.analysisId);
      const changed = next.updatedAt !== view.analysis?.updatedAt;
      view.analysis = next;
      view.error = null;
      if (changed) {
        await pushToPage();
        render();
      }
      if (!isDone(next)) schedulePoll(gen);
    } catch (e) {
      view.error = message(e);
      render();
      schedulePoll(gen);
    }
  }, POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- Отрисовка (только textContent) ---

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: { cls?: string; text?: string } = {}, ...children: (Node | null)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.cls) node.className = props.cls;
  if (props.text !== undefined) node.textContent = props.text;
  for (const c of children) if (c) node.append(c);
  return node;
}

function button(text: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = h("button", { cls, text });
  b.type = "button";
  b.disabled = view.busy !== null;
  b.addEventListener("click", onClick);
  return b;
}

function sourced(label: string, value: string | null, quality?: SourcedValue<string>["quality"]): HTMLElement {
  const row = h("div", { cls: "meta-row" }, h("span", { cls: "meta-label", text: label }));
  if (!value) row.append(h("span", { cls: "muted", text: "не удалось определить" }));
  else {
    row.append(h("span", { text: value }));
    if (quality && quality !== "confirmed") row.append(h("span", { cls: "muted", text: " (по разметке, не сверено со страницей)" }));
  }
  return row;
}

function formatDate(v: SourcedValue<string> | null): string | null {
  if (!v) return null;
  const d = new Date(v.value);
  return Number.isNaN(d.getTime()) ? v.value : d.toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
}

function metadataSection(m: ArticleMetadata): HTMLElement {
  const authors = m.authors.map((a) => a.name).join(", ") || null;
  const authorQuality = m.authors.every((a) => a.quality === "confirmed") ? "confirmed" : "plausible";
  return h(
    "section",
    { cls: "meta" },
    h("h2", { text: m.title ?? "Без заголовка" }),
    sourced("Автор:", authors, authors ? authorQuality : undefined),
    sourced("Опубликовано:", formatDate(m.publishedAt), m.publishedAt?.quality),
    m.modifiedAt ? sourced("Обновлено:", formatDate(m.modifiedAt), m.modifiedAt.quality) : null,
  );
}

function progressSection(a: AnalysisState): HTMLElement {
  const s = a.stats;
  const lines: string[] = [];
  if (a.status === "queued" || a.status === "extracting_claims") lines.push("Статья извлечена. Ищем проверяемые утверждения…");
  else lines.push(`Найдено утверждений: ${s.total}${s.opinions ? ` (и мнений: ${s.opinions})` : ""}. Проверено ${s.completed} из ${s.total}.`);
  if (a.status === "cancelled") lines.push(`Проверка отменена. Не проверено: ${s.notChecked}.`);
  const section = h("section", { cls: "progress" });
  if (a.preliminary || a.status === "cancelled") section.append(h("div", { cls: "badge-preliminary", text: "Предварительный результат" }));
  for (const l of lines) section.append(h("p", { text: l }));
  if (s.total > 0) {
    const bar = h("div", { cls: "bar" });
    const fill = h("div", { cls: "bar-fill" });
    fill.style.width = `${Math.round((s.completed / s.total) * 100)}%`;
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(s.completed));
    bar.setAttribute("aria-valuemax", String(s.total));
    bar.append(fill);
    section.append(bar);
    const dist = h("ul", { cls: "dist" });
    for (const v of VERDICTS) dist.append(h("li", { cls: `s-${v}`, text: `${LABELS[v].icon} ${LABELS[v].text}: ${s.byVerdict[v]}` }));
    if (s.failed) dist.append(h("li", { cls: "s-failed", text: `${LABELS.failed.icon} ${LABELS.failed.text}: ${s.failed}` }));
    if (s.notChecked) dist.append(h("li", { cls: "s-not_checked", text: `${LABELS.not_checked.icon} ${LABELS.not_checked.text}: ${s.notChecked}` }));
    section.append(dist);
  }
  if (a.error) section.append(h("p", { cls: "error", text: a.error }));
  if (a.summary) section.append(h("div", { cls: "summary" }, h("h3", { text: "Сводка" }), h("p", { text: a.summary })));
  return section;
}

function claimItem(c: Claim): HTMLElement {
  const state = displayState(c);
  const item = h(
    "li",
    { cls: "claim" },
    h("span", { cls: `badge s-${state}`, text: `${LABELS[state].icon ? `${LABELS[state].icon} ` : ""}${LABELS[state].text}` }),
    h("div", { text: c.normalizedClaim }),
    c.status === "failed" && c.error ? h("div", { cls: "muted", text: c.error }) : null,
  );
  item.tabIndex = 0;
  const focus = () => void sendToTab({ type: "vh:focus", blockId: c.occurrences[0]?.blockId ?? c.blockIds[0]! }).catch(() => undefined);
  item.addEventListener("click", focus);
  item.addEventListener("keydown", (e) => e.key === "Enter" && focus());
  return item;
}

function render(): void {
  const a = view.analysis;
  const children: (Node | null)[] = [];
  if (view.geminiConfigured === false) children.push(h("p", { cls: "warning", text: "На сервере не задан GEMINI_API_KEY: проверка утверждений будет недоступна." }));
  if (view.metadata) children.push(metadataSection(view.metadata));

  if (!a && !view.busy) {
    children.push(
      h("p", { cls: "privacy", text: "Текст статьи (заголовок, автор, дата и абзацы) будет отправлен на локальный сервер 127.0.0.1 и далее в Gemini API для поиска источников. Ничего не отправляется без нажатия кнопки." }),
      button("Проанализировать статью", () => void analyze(false), "primary"),
    );
  }
  if (view.busy) children.push(h("p", { cls: "busy", text: view.busy }));
  if (view.stale) children.push(h("p", { cls: "warning", text: "Текст страницы изменился после анализа. Результат не привязан к новому тексту — повторите анализ." }));
  if (view.notice) children.push(h("p", { cls: "muted", text: view.notice }));
  if (view.error) children.push(h("p", { cls: "error", text: view.error }));

  if (a) {
    children.push(progressSection(a));
    const actions = h("div", { cls: "actions" });
    if (!TERMINAL.has(a.status)) actions.append(button("Отменить", () => void cancel()));
    actions.append(button("Повторить анализ", () => void analyze(true)), button("Удалить результат", () => void removeResult(), "danger"));
    children.push(actions);
    const facts = a.claims.filter((c) => c.status !== "opinion");
    const opinions = a.claims.filter((c) => c.status === "opinion");
    if (facts.length) children.push(h("h3", { text: "Утверждения" }), h("ul", { cls: "claims" }, ...facts.map(claimItem)));
    if (opinions.length) children.push(h("h3", { text: "Мнения (не проверяются)" }), h("ul", { cls: "claims" }, ...opinions.map(claimItem)));
  }
  root.replaceChildren(...children.filter((c): c is Node => c !== null));
}

chrome.tabs.onActivated.addListener(() => void init());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === view.tabId && (info.url || info.status === "complete")) void init();
});
void init();
