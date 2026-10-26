// Различия Chrome и Firefox в одном месте. В Firefox API расширений доступно как `browser` (с промисами),
// в Chrome — как `chrome`; формы вызовов, которые использует «Сверка», у них совпадают.

type FirefoxGlobals = {
  browser?: typeof chrome & { sidebarAction?: { open(): Promise<void> } };
};

const globals = globalThis as unknown as FirefoxGlobals & { chrome?: typeof chrome };

/** API расширений текущего браузера. */
export const ext: typeof chrome = (globals.browser ?? globals.chrome) as typeof chrome;

export const isFirefox = typeof globals.browser?.sidebarAction?.open === "function";

/**
 * Открывает боковую панель. Вызывать синхронно из обработчика действия пользователя (клик по значку,
 * пункт контекстного меню): оба браузера разрешают открытие только в ответ на действие пользователя.
 */
export function openPanel(windowId: number | undefined): void {
  if (globals.browser?.sidebarAction) {
    void globals.browser.sidebarAction.open();
    return;
  }
  if (windowId !== undefined) void ext.sidePanel.open({ windowId });
}

/** Chrome: панель открывается нашим обработчиком, а не автоматически по клику на значок. В Firefox не нужно. */
export function configurePanel(): void {
  if (!isFirefox && ext.sidePanel?.setPanelBehavior) void ext.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}
