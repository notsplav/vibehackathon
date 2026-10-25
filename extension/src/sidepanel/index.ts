// Боковая панель: запуск анализа, прогресс, список утверждений, сводка и ошибки.
// Прогресс хранится на сервере; панель запоминает только analysisId для URL вкладки и восстанавливается по нему.

import type { AnalysisState, ArticleMetadata, Claim, ExtractedArticle, HealthResponse, SourcedValue } from "../../../shared/contract.ts";
import { LABELS, displayState } from "../labels.ts";
import {
  CHECK_SELECTION,
  type ExtractReply,
  type PanelMessage,
  PENDING_SELECTION_KEY,
  type PendingSelection,
  type RenderReply,
  SETTINGS_CHANGED,
} from "../messages.ts";
import { ApiError, api } from "./api.ts";
import { type IconName, icon } from "./icons.ts";
import { liveStep, renderProgress, tick } from "./progress.ts";

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
  health: HealthResponse | null;
}

const view: View = { tabId: null, url: null, saved: null, analysis: null, metadata: null, busy: null, error: null, notice: null, stale: false, health: null };
let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** Время последнего успешного опроса сервера — показывается как «обновлено N с назад». */
let lastPollAt: number | null = null;
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

/** Что проверять: всю статью или выделенный фрагмент (hint — его текст, если выделение снято). */
interface Scope {
  selection?: { hint: string | null; onlyHint?: boolean };
}

async function extract(scope: Scope = {}): Promise<{ article: ExtractedArticle; fingerprint: string }> {
  await inject();
  const msg: PanelMessage = scope.selection
    ? { type: "vh:extract-selection", hint: scope.selection.hint, onlyHint: scope.selection.onlyHint }
    : { type: "vh:extract" };
  const reply = await sendToTab<ExtractReply>(msg);
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
    (health) => ((view.health = health), render()),
    () => ((view.health = null), render()),
  );
  if (!view.url) return;
  const key = storageKey(view.url);
  const saved = ((await chrome.storage.local.get(key)) as Record<string, Saved | undefined>)[key] ?? null;
  if (gen !== generation || !saved) return;
  view.saved = saved;
  try {
    view.analysis = await api.get(saved.analysisId);
    lastPollAt = Date.now();
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

async function analyze(force: boolean, scope: Scope = {}): Promise<void> {
  const gen = ++generation;
  stopPolling();
  Object.assign(view, { error: null, notice: null, stale: false, busy: scope.selection ? "Готовим выделенный фрагмент…" : "Извлекаем статью…" });
  render();
  try {
    const { article, fingerprint } = await extract(scope);
    view.metadata = article.metadata;
    if (article.extraction.status !== "ok") {
      view.busy = null;
      view.error = EXTRACTION_ERRORS[article.extraction.error?.code ?? ""] ?? "Не удалось извлечь статью.";
      render();
      return;
    }
    view.busy = article.focus
      ? `Фрагмент и контекст: блоков ${article.blocks.length}. Отправляем на проверку…`
      : `Статья извлечена: блоков ${article.blocks.length}. Отправляем на проверку…`;
    render();
    const created = await api.create(article, force);
    view.saved = { analysisId: created.analysisId, fingerprint };
    await chrome.storage.local.set({ [storageKey(view.url ?? article.url)]: view.saved });
    view.analysis = await api.get(created.analysisId);
    lastPollAt = Date.now();
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
      lastPollAt = Date.now();
      // Живой прогресс меняется без updatedAt (шаги проверки хранятся только в памяти сервера).
      const changed = next.updatedAt !== view.analysis?.updatedAt || JSON.stringify(next.live) !== JSON.stringify(view.analysis?.live);
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

function claimItem(c: Claim, a: AnalysisState): HTMLElement {
  const state = displayState(c);
  const step = liveStep(a, c);
  const item = h(
    "li",
    { cls: `claim${step ? " is-active" : ""}` },
    h("span", { cls: `badge s-${state}`, text: `${LABELS[state].icon ? `${LABELS[state].icon} ` : ""}${LABELS[state].text}` }),
    step ? h("span", { cls: "claim-step", text: ` · ${step}` }) : null,
    h("div", { text: c.normalizedClaim }),
    c.status === "failed" && c.error ? h("div", { cls: "muted", text: c.error }) : null,
  );
  item.tabIndex = 0;
  const focus = () => void sendToTab({ type: "vh:focus", blockId: c.occurrences[0]?.blockId ?? c.blockIds[0]! }).catch(() => undefined);
  item.addEventListener("click", focus);
  item.addEventListener("keydown", (e) => e.key === "Enter" && focus());
  return item;
}

/** Чем будет проверяться статья: модель и поиск, по ответу сервера. */
function engineInfo(health: HealthResponse | null): HTMLElement {
  const info = h("dl", { cls: "engine" });
  if (!health) return info;
  info.append(h("dt", { text: "Модель:" }), h("dd", { text: health.model }), h("dt", { text: "Поиск:" }), h("dd", { text: health.search }));
  return info;
}

/** Стартовый экран: одна кнопка по центру панели и короткое пояснение под ней. */
function startScreen(): HTMLElement {
  return h(
    "section",
    { cls: "start" },
    button("Начать проверку", () => void analyze(false), "primary cta"),
    button("Проверить выделенное", () => void analyze(false, { selection: { hint: null } }), "secondary"),
    h("p", { cls: "start-tip", text: "Или выделите текст и нажмите правой кнопкой → «Сверка: проверить выделенное»." }),
    engineInfo(view.health),
  );
}

/** Какой фрагмент проверяется — над ходом проверки. */
function focusBox(text: string): HTMLElement {
  const short = text.length > 240 ? `${text.slice(0, 240)}…` : text;
  return h("section", { cls: "focus" }, h("div", { cls: "focus-label", text: "Проверяется выделенный фрагмент" }), h("p", { cls: "focus-text", text: `«${short}»` }));
}

/** Проверка из контекстного меню: фоновый скрипт оставляет запрос, панель забирает его один раз. */
async function consumePendingSelection(): Promise<void> {
  const stored = (await chrome.storage.session.get(PENDING_SELECTION_KEY)) as Record<string, PendingSelection | undefined>;
  const pending = stored[PENDING_SELECTION_KEY];
  if (!pending || pending.tabId !== view.tabId || Date.now() - pending.at > 60_000) return;
  await chrome.storage.session.remove(PENDING_SELECTION_KEY);
  await analyze(false, { selection: { hint: pending.text || null } });
}

/** Удаление подтверждается вторым нажатием в течение нескольких секунд. */
const DELETE_CONFIRM_MS = 3000;
let deleteArmedUntil = 0;

function iconButton(name: IconName, label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = h("button", { cls: `icon-btn ${cls}`.trim() });
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.disabled = view.busy !== null;
  b.append(icon(document, name));
  b.addEventListener("click", onClick);
  return b;
}

function actionButtons(a: AnalysisState): HTMLElement {
  const bar = h("div", { cls: "head-actions" });
  if (!TERMINAL.has(a.status)) bar.append(iconButton("stop", "Остановить проверку", () => void cancel()));
  // Повтор проверяет тот же объём: всю статью или тот же выделенный фрагмент.
  bar.append(iconButton("retry", "Проверить заново", () => void analyze(true, a.focus ? { selection: { hint: a.focus.text, onlyHint: true } } : {})));
  const armed = Date.now() < deleteArmedUntil;
  bar.append(
    iconButton(
      "trash",
      armed ? "Нажмите ещё раз, чтобы удалить результат" : "Удалить результат",
      () => {
        if (Date.now() < deleteArmedUntil) {
          deleteArmedUntil = 0;
          void removeResult();
          return;
        }
        deleteArmedUntil = Date.now() + DELETE_CONFIRM_MS;
        render();
        setTimeout(render, DELETE_CONFIRM_MS + 50);
      },
      armed ? "danger is-armed" : "danger",
    ),
  );
  return bar;
}

function render(): void {
  const a = view.analysis;
  const children: (Node | null)[] = [];
  if (view.health?.problem) children.push(h("p", { cls: "warning", text: view.health.problem }));
  if (view.metadata) children.push(metadataSection(view.metadata));

  const idle = !a && !view.busy;
  root.classList.toggle("is-idle", idle);
  if (view.busy) children.push(h("p", { cls: "busy", text: view.busy }));
  if (view.stale) children.push(h("p", { cls: "warning", text: "Текст страницы изменился после анализа. Результат не привязан к новому тексту — повторите анализ." }));
  if (view.notice) children.push(h("p", { cls: "muted", text: view.notice }));
  if (view.error) children.push(h("p", { cls: "error", text: view.error }));
  if (idle) children.push(startScreen());

  if (a) {
    if (a.focus) children.push(focusBox(a.focus.text));
    children.push(renderProgress(a, lastPollAt, actionButtons(a)));
    const facts = a.claims.filter((c) => c.status !== "opinion");
    const opinions = a.claims.filter((c) => c.status === "opinion");
    if (facts.length) children.push(h("h3", { text: "Утверждения" }), h("ul", { cls: "claims" }, ...facts.map((c) => claimItem(c, a))));
    if (opinions.length) children.push(h("h3", { text: "Мнения (не проверяются)" }), h("ul", { cls: "claims" }, ...opinions.map((c) => claimItem(c, a))));
  }
  root.replaceChildren(...children.filter((c): c is Node => c !== null));
}

// Шестерёнка в шапке открывает нативную страницу настроек расширения.
const settingsButton = document.getElementById("open-settings");
if (settingsButton) {
  settingsButton.append(icon(document, "settings"));
  settingsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());
}
// После сохранения настроек обновляем подпись «Модель / Поиск» и предупреждения.
chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === CHECK_SELECTION) void consumePendingSelection();
  if (msg?.type === SETTINGS_CHANGED) {
    api.health().then(
      (health) => ((view.health = health), render()),
      () => undefined,
    );
  }
});

// Таймеры и «обновлено N с назад» меняются каждую секунду без перерисовки всей панели.
setInterval(() => tick(root), 1000);

chrome.tabs.onActivated.addListener(() => void init());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === view.tabId && (info.url || info.status === "complete")) void init();
});
// Панель могла открыться из контекстного меню — тогда сразу проверяем выделение.
void init().then(() => consumePendingSelection());
