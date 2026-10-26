import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GECKO_ID, firefoxManifest } from "../scripts/manifest.ts";
import { ROOT } from "./fixtures.ts";

test("манифест Firefox: event page, sidebar_action, ID gecko; без ключей, которые есть только у Chrome", () => {
  const chrome = JSON.parse(readFileSync(join(ROOT, "extension/static/manifest.json"), "utf8"));
  const ff = firefoxManifest(chrome);
  expect(ff.background).toEqual({ scripts: ["background.js"] });
  expect(ff.sidebar_action).toMatchObject({ default_panel: "sidepanel.html" });
  expect(ff.browser_specific_settings).toEqual({ gecko: { id: GECKO_ID, strict_min_version: "128.0" } });
  for (const key of ["key", "side_panel", "minimum_chrome_version"]) expect(ff).not.toHaveProperty(key);
  expect(ff.permissions).not.toContain("sidePanel");
  expect(ff.permissions).toEqual(expect.arrayContaining(["activeTab", "scripting", "storage", "contextMenus", "nativeMessaging"]));
  // Остальное совпадает с Chrome: имя, версия, кнопка на панели инструментов.
  expect([ff.name, ff.version, ff.action]).toEqual([chrome.name, chrome.version, chrome.action]);
});
