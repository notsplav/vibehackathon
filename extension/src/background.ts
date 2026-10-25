// Service worker: только открывает боковую панель по нажатию на значок.
// Состояние анализа хранится на сервере, поэтому завершение worker'а ничего не ломает.

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

chrome.action.onClicked.addListener((tab) => {
  // Вызов в обработчике клика: Chrome требует жест пользователя; заодно выдаётся activeTab.
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});
