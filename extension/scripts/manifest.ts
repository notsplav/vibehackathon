// Манифест Firefox из манифеста Chrome (extension/static/manifest.json): тот же код, другие ключи платформы.

/** ID расширения в Firefox: с ним помощник (allowed_extensions) принимает сообщения только от «Сверки». */
export const GECKO_ID = "sverka@vibehackathon";
/** Firefox 128 ESR: MV3, scripting, storage.session, sidebarAction. */
export const GECKO_MIN_VERSION = "128.0";

type Manifest = Record<string, unknown> & { permissions?: string[] };

export function firefoxManifest(chrome: Manifest): Manifest {
  const { key: _key, side_panel: _sidePanel, minimum_chrome_version: _minChrome, background: _bg, ...rest } = chrome;
  return {
    ...rest,
    // В Firefox фон — event page из обычного скрипта, а не service worker.
    background: { scripts: ["background.js"] },
    sidebar_action: { default_panel: "sidepanel.html", default_title: "Сверка", open_at_install: false },
    permissions: (chrome.permissions ?? []).filter((p) => p !== "sidePanel"),
    browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: GECKO_MIN_VERSION } },
  };
}
