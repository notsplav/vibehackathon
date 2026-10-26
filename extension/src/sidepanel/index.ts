// Боковая панель: запуск проверки, прогресс, список утверждений, сводка и ошибки.
// Проверку ведёт фоновый скрипт через помощника «Сверки»; панель читает состояние из chrome.storage.local
// и обновляется по storage.onChanged — её можно закрыть и открыть снова, ничего не теряя.

import type { AnalysisState, ArticleMetadata, Claim, ExtractedArticle, SourcedValue } from "../../../shared/contract.ts";
import { LABELS, displayState } from "../labels.ts";
import {
  CHECK_SELECTION,
  type ExtractReply,
  type PanelMessage,
  PENDING_SELECTION_KEY,
  type PendingSelection,
  type RenderReply,
} from "../messages.ts";
import { type BgReply, type BgRequest, type HostStatus, type PageEntry, analysisKey, pageKey } from "../state.ts";
import { type IconName, icon } from "./icons.ts";
import { liveStep, renderProgress, tick } from "./progress.ts";

const TERMINAL = new Set(["completed", "cancelled", "failed"]);

interface View {
  tabId: number | null;
  url: string | null;
  saved: PageEntry | null;
  analysis: AnalysisState | null;
  metadata: ArticleMetadata | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  stale: boolean;
  host: HostStatus | null;
}

const view: View = { tabId: null, url: null, saved: null, analysis: null, metadata: null, busy: null, error: null, notice: null, stale: false, host: null };
let generation = 0;

const root = document.getElementById("app")!;

// --- Связь с фоновым скриптом и вкладкой ---

async function bg(req: BgRequest): Promise<BgReply & { ok: true }> {
  const reply = (await chrome.runtime.sendMessage(req)) as BgReply | undefined;
  if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : "Фоновый скрипт расширения не ответил.");
  return reply;
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

/** Статус помощника кэшируется на минуту: каждая проверка статуса запускает процесс помощника. */
let statusCache: { at: number; status: HostStatus } | null = null;

async function hostStatus(): Promise<HostStatus> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.status;
  const status = await bg({ type: "bg:status" }).then(
    (r) => r.status ?? { ready: false, problem: "Нет ответа от фонового скрипта.", extractModel: null, checkModel: null },
    (e) => ({ ready: false, problem: message(e), extractModel: null, checkModel: null }),
  );
  // Ошибку не кэшируем: пользователь мог только что установить помощника.
  if (status.ready) statusCache = { at: Date.now(), status };
  return status;
}

async function readAnalysis(id: string): Promise<AnalysisState | null> {
  const key = analysisKey(id);
  return ((await chrome.storage.local.get(key)) as Record<string, AnalysisState | undefined>)[key] ?? null;
}

// --- Действия ---

async function init(): Promise<void> {
  const gen = ++generation;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  Object.assign(view, { tabId: tab?.id ?? null, url: tab?.url ?? null, saved: null, analysis: null, metadata: null, busy: null, error: null, notice: null, stale: false });
  render();
  void hostStatus().then((status) => ((view.host = status), render()));
  if (!view.url) return;
  const key = pageKey(view.url);
  const saved = ((await chrome.storage.local.get(key)) as Record<string, PageEntry | undefined>)[key] ?? null;
  if (gen !== generation || !saved) return;
  const analysis = await readAnalysis(saved.analysisId);
  if (!analysis) {
    await chrome.storage.local.remove(key);
    return;
  }
  Object.assign(view, { saved, analysis, metadata: analysis.metadata });
  render();
  // Восстанавливаем маркеры: извлечение локальное, никуда не отправляется.
  try {
    const { fingerprint } = await extract(analysis.focus ? { selection: { hint: analysis.focus.text, onlyHint: true } } : {});
    if (fingerprint !== saved.fingerprint) view.stale = true;
    else await pushToPage();
  } catch {
    view.notice = "Маркеры на странице не восстановлены: нажмите на значок расширения на вкладке статьи.";
  }
  render();
}

async function analyze(scope: Scope = {}): Promise<void> {
  ++generation;
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
    const { analysisId } = await bg({ type: "bg:start", url: view.url ?? article.url, article, fingerprint });
    view.saved = { analysisId: analysisId!, fingerprint };
    view.analysis = await readAnalysis(analysisId!);
    view.busy = null;
    await pushToPage();
    render();
  } catch (e) {
    view.busy = null;
    view.error = message(e);
    render();
  }
}

async function cancel(): Promise<void> {
  if (!view.saved) return;
  await bg({ type: "bg:cancel", analysisId: view.saved.analysisId }).catch((e) => (view.error = message(e)));
  render();
}

async function removeResult(): Promise<void> {
  if (!view.saved || !view.url) return;
  try {
    await bg({ type: "bg:delete", analysisId: view.saved.analysisId, url: view.url });
  } catch (e) {
    view.error = message(e);
    render();
    return;
  }
  await sendToTab({ type: "vh:clear" }).catch(() => undefined);
  Object.assign(view, { saved: null, analysis: null, stale: false, notice: "Результат удалён." });
  render();
}

async function pushToPage(): Promise<void> {
  if (!view.analysis || !view.saved || view.stale) return;
  const reply = await sendToTab<RenderReply>({ type: "vh:render", claims: view.analysis.claims, fingerprint: view.saved.fingerprint }).catch(() => null);
  if (reply?.ok && reply.stale) view.stale = true;
}

// Каждое событие проверки фоновый скрипт пишет в storage — панель просто следит за своей записью.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !view.saved) return;
  const change = changes[analysisKey(view.saved.analysisId)];
  if (!change?.newValue) return;
  const prev = view.analysis;
  view.analysis = change.newValue as AnalysisState;
  // Маркеры на странице меняются только при изменении утверждений, а не при каждом шаге поиска.
  if (JSON.stringify(prev?.claims) !== JSON.stringify(view.analysis.claims)) void pushToPage();
  render();
});

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

/** Чем будет проверяться статья: модели Claude Code по ответу помощника. */
function engineInfo(host: HostStatus | null): HTMLElement {
  const info = h("dl", { cls: "engine" });
  if (!host?.ready) return info;
  info.append(
    h("dt", { text: "Утверждения:" }),
    h("dd", { text: host.extractModel ?? "" }),
    h("dt", { text: "Проверка:" }),
    h("dd", { text: `${host.checkModel ?? ""} + WebSearch` }),
  );
  return info;
}

/** Стартовый экран: одна кнопка по центру панели и короткое пояснение под ней. */
function startScreen(): HTMLElement {
  return h(
    "section",
    { cls: "start" },
    button("Начать проверку", () => void analyze(), "primary cta"),
    button("Проверить выделенное", () => void analyze({ selection: { hint: null } }), "secondary"),
    h("p", { cls: "start-tip", text: "Или выделите текст и нажмите правой кнопкой → «Сверка: проверить выделенное»." }),
    engineInfo(view.host),
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
  await analyze({ selection: { hint: pending.text || null } });
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
  bar.append(iconButton("retry", "Проверить заново", () => void analyze(a.focus ? { selection: { hint: a.focus.text, onlyHint: true } } : {})));
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
  if (view.host?.problem) children.push(h("p", { cls: "warning", text: view.host.problem }));
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
    children.push(renderProgress(a, null, actionButtons(a)));
    const facts = a.claims.filter((c) => c.status !== "opinion");
    const opinions = a.claims.filter((c) => c.status === "opinion");
    if (facts.length) children.push(h("h3", { text: "Утверждения" }), h("ul", { cls: "claims" }, ...facts.map((c) => claimItem(c, a))));
    if (opinions.length) children.push(h("h3", { text: "Мнения (не проверяются)" }), h("ul", { cls: "claims" }, ...opinions.map((c) => claimItem(c, a))));
  }
  root.replaceChildren(...children.filter((c): c is Node => c !== null));
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === CHECK_SELECTION) void consumePendingSelection();
});

// Таймеры меняются каждую секунду без перерисовки всей панели.
setInterval(() => tick(root), 1000);

chrome.tabs.onActivated.addListener(() => void init());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === view.tabId && (info.url || info.status === "complete")) void init();
});
// Панель могла открыться из контекстного меню — тогда сразу проверяем выделение.
void init().then(() => consumePendingSelection());
