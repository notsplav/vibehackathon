// Service worker: открывает боковую панель по значку и пункту контекстного меню «Проверить выделенное».
// Состояние анализа хранится на сервере, поэтому завершение worker'а ничего не ломает.

import { CHECK_SELECTION, PENDING_SELECTION_KEY, type PendingSelection } from "./messages.ts";

const MENU_ID = "vh-check-selection";

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
