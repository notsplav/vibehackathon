import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/** Загружает HTML в jsdom без выполнения скриптов и загрузки ресурсов. */
export function loadDocument(path: string, url: string): Document {
  const html = readFileSync(path, "utf8");
  return new JSDOM(html, { url, pretendToBeVisual: true }).window.document;
}
