// Фоновый скрипт: открывает панель, держит соединение с помощником «Сверки» (Native Messaging)
// и записывает каждое событие проверки в chrome.storage.local. Пока соединение открыто, Chrome не
// выгружает фоновый скрипт; после всех проверок соединение закрывается и помощник завершается.

import type { AnalysisState } from "../../shared/contract.ts";
import { HOST_NAME, type HostEvent, type HostRequest } from "../../shared/host.ts";
import { CHECK_SELECTION, PENDING_SELECTION_KEY, type PendingSelection } from "./messages.ts";
import { type BgReply, type BgRequest, type HostStatus, type PageEntry, analysisKey, newAnalysis, pageKey, withClaims } from "./state.ts";

const MENU_ID = "vh-check-selection";
const NOT_INSTALLED = "Помощник «Сверки» не установлен. В папке проекта выполните npm run install:host и перезагрузите расширение.";

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  chrome.contextMenus.create({ id: MENU_ID, title: "Сверка: проверить выделенное", contexts: ["selection"] });
});

chrome.action.onClicked.addListener((tab) => {
  // Вызов в обработчике клика: Chrome требует жест пользователя; заодно выдаётся activeTab.
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || tab.windowId === undefined) return;
  // Панель открывается сразу (нужен жест пользователя), а запрос на проверку оставляем ей в session storage:
  // открытая панель получит сообщение, только что открытая — заберёт запрос при запуске.
  void chrome.sidePanel.open({ windowId: tab.windowId });
  const pending: PendingSelection = { tabId: tab.id, text: info.selectionText ?? "", at: Date.now() };
  void chrome.storage.session
    .set({ [PENDING_SELECTION_KEY]: pending })
    .then(() => chrome.runtime.sendMessage({ type: CHECK_SELECTION }))
    .catch(() => undefined);
});

// --- Соединение с помощником ---

let port: chrome.runtime.Port | null = null;
const active = new Set<string>();
/** Записи в storage идут по очереди, чтобы быстрые события не затирали друг друга. */
let writes: Promise<unknown> = Promise.resolve();

function hostMessage(error: string | undefined): string {
  if (!error) return "Помощник «Сверки» завершился неожиданно.";
  if (/not found|not installed|forbidden/i.test(error)) return NOT_INSTALLED;
  return `Помощник «Сверки» недоступен: ${error}`;
}

function ensurePort(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connectNative(HOST_NAME);
  p.onMessage.addListener((msg: HostEvent) => {
    if (msg.type !== "pong") apply(msg);
  });
  p.onDisconnect.addListener(() => {
    const reason = hostMessage(chrome.runtime.lastError?.message);
    port = null;
    for (const id of [...active]) void update(id, (s) => fail(s, reason));
    active.clear();
  });
  port = p;
  return p;
}

function post(msg: HostRequest): void {
  ensurePort().postMessage(msg);
}

/** Закрываем соединение, когда проверок нет: помощник и процессы claude завершаются. */
function releaseIfIdle(): void {
  if (active.size === 0 && port) {
    port.disconnect();
    port = null;
  }
}

function fail(s: AnalysisState, error: string): AnalysisState {
  const claims = s.claims.map((c) => (c.status === "queued" || c.status === "checking" ? { ...c, status: "failed" as const, error } : c));
  return withClaims({ ...s, status: "failed", error, live: null }, claims);
}

function update(id: string, change: (s: AnalysisState) => AnalysisState): Promise<unknown> {
  writes = writes
    .then(async () => {
      const key = analysisKey(id);
      const s = ((await chrome.storage.local.get(key)) as Record<string, AnalysisState | undefined>)[key];
      if (s) await chrome.storage.local.set({ [key]: change(s) });
    })
    // Одна неудачная запись не должна останавливать все следующие события.
    .catch((e: unknown) => console.warn("Сверка: не удалось сохранить событие проверки", e));
  return writes;
}

function apply(e: Exclude<HostEvent, { type: "pong" }>): void {
  void update(e.id, (s) => {
    switch (e.type) {
      case "stage": {
        const done = e.status === "completed" || e.status === "failed" || e.status === "cancelled";
        if (done) {
          active.delete(e.id);
          queueMicrotask(releaseIfIdle);
        }
        return withClaims({ ...s, status: e.status, error: e.error ?? s.error, live: done ? null : s.live }, s.claims);
      }
      case "claims":
        return withClaims(s, e.claims);
      case "claim":
        return withClaims(s, s.claims.map((c) => (c.id === e.claim.id ? e.claim : c)));
      case "live":
        return { ...s, live: e.live, updatedAt: new Date().toISOString() };
      case "summary":
        return { ...s, summary: e.summary, updatedAt: new Date().toISOString() };
      case "cost":
        return s;
    }
  });
}

/** Проверка установки: короткое соединение с ping. */
function status(): Promise<HostStatus> {
  return new Promise((resolve) => {
    let p: chrome.runtime.Port;
    try {
      p = chrome.runtime.connectNative(HOST_NAME);
    } catch {
      resolve({ ready: false, problem: NOT_INSTALLED, extractModel: null, checkModel: null });
      return;
    }
    const timer = setTimeout(() => (p.disconnect(), resolve({ ready: false, problem: "Помощник «Сверки» не отвечает.", extractModel: null, checkModel: null })), 5000);
    p.onMessage.addListener((msg: HostEvent) => {
      if (msg.type !== "pong") return;
      clearTimeout(timer);
      p.disconnect();
      resolve({
        ready: msg.claudeFound,
        problem: msg.claudeFound ? null : "Помощник не нашёл Claude Code. Установите его и повторите npm run install:host.",
        extractModel: msg.defaults.extractModel,
        checkModel: msg.defaults.checkModel,
      });
    });
    p.onDisconnect.addListener(() => {
      clearTimeout(timer);
      resolve({ ready: false, problem: hostMessage(chrome.runtime.lastError?.message), extractModel: null, checkModel: null });
    });
    p.postMessage({ type: "ping" } satisfies HostRequest);
  });
}

async function handle(req: BgRequest): Promise<BgReply> {
  await recovered;
  switch (req.type) {
    case "bg:status":
      return { ok: true, status: await status() };
    case "bg:start": {
      const id = crypto.randomUUID();
      const page: PageEntry = { analysisId: id, fingerprint: req.fingerprint };
      active.add(id);
      await chrome.storage.local.set({ [analysisKey(id)]: newAnalysis(id, req.article), [pageKey(req.url)]: page });
      try {
        post({ type: "analyze", id, article: req.article });
      } catch (e) {
        active.delete(id);
        await update(id, (s) => fail(s, hostMessage(e instanceof Error ? e.message : String(e))));
      }
      return { ok: true, analysisId: id };
    }
    case "bg:cancel":
      if (active.has(req.analysisId) && port) port.postMessage({ type: "cancel", id: req.analysisId } satisfies HostRequest);
      return { ok: true };
    case "bg:delete":
      if (active.has(req.analysisId) && port) port.postMessage({ type: "cancel", id: req.analysisId } satisfies HostRequest);
      active.delete(req.analysisId);
      await chrome.storage.local.remove([analysisKey(req.analysisId), pageKey(req.url)]);
      releaseIfIdle();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((req: BgRequest, _sender, sendResponse) => {
  if (typeof req?.type !== "string" || !req.type.startsWith("bg:")) return false;
  handle(req).then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
});

// Если Chrome перезапустил фоновый скрипт, соединение с помощником потеряно: незавершённые проверки
// помечаются прерванными, чтобы панель не ждала их вечно.
/** Сколько последних проверок хранить: старые удаляются, чтобы не упереться в квоту storage. */
const KEEP_ANALYSES = 30;

const recovered = (async () => {
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const analyses = Object.entries(all)
    .filter(([key, value]) => key.startsWith("analysis:") && !key.startsWith("analysis:http") && typeof (value as AnalysisState)?.createdAt === "string")
    .sort(([, a], [, b]) => ((b as AnalysisState).createdAt > (a as AnalysisState).createdAt ? 1 : -1));
  const stale = new Set(analyses.slice(KEEP_ANALYSES).map(([key]) => key));
  if (stale.size) {
    const pages = Object.entries(all).filter(([key, v]) => key.startsWith("page:") && stale.has(analysisKey((v as PageEntry).analysisId))).map(([key]) => key);
    await chrome.storage.local.remove([...stale, ...pages]);
    for (const key of stale) delete all[key];
  }
  for (const [key, value] of Object.entries(all)) {
    // Записи старой версии с сервером («analysis:<url>») больше не нужны.
    if (key.startsWith("analysis:http")) {
      await chrome.storage.local.remove(key);
      continue;
    }
    const s = value as AnalysisState;
    if (key.startsWith("analysis:") && !active.has(s.analysisId) && ["queued", "extracting_claims", "checking"].includes(s.status)) {
      await chrome.storage.local.set({ [key]: fail(s, "Проверка прервалась: браузер остановил фоновый процесс. Нажмите ↻, чтобы проверить заново.") });
    }
  }
})();
