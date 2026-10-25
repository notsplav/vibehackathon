import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
const EXPECTED_DIR = join(ROOT, "fixtures/expected");
const LOCAL_DIR = join(ROOT, "fixtures/local");

export interface ExpectedCase {
  name: string;
  description: string;
  /** Либо своя страница в fixtures/pages, либо чужая статья, которую каждый сохраняет локально. */
  source: { file: string } | { url: string; savedAt: string };
  url: string;
  expected: {
    status: "ok" | "failed";
    method: string;
    errorCode?: string;
    pageType: string;
    language: string | null;
    canonicalUrl: string | null;
    metadata: unknown;
    blocks: { type: string; text: string }[];
    warnings: string[];
  };
}

export function loadExpectedCases(): ExpectedCase[] {
  return readdirSync(EXPECTED_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(join(EXPECTED_DIR, f), "utf8")) }));
}

/**
 * Путь к HTML для случая. Для чужих статей: TEST_ARTICLE_HTML или любой файл в fixtures/local/,
 * содержащий URL статьи (имя файла может быть любым). null — копии нет, тест пропускается.
 */
export function resolveHtml(c: ExpectedCase): string | null {
  if ("file" in c.source) return join(ROOT, c.source.file);
  const url = c.source.url;
  const env = process.env.TEST_ARTICLE_HTML;
  if (env && existsSync(env) && readFileSync(env, "utf8").includes(url)) return env;
  if (!existsSync(LOCAL_DIR)) return null;
  for (const f of readdirSync(LOCAL_DIR)) {
    if (!/\.html?$/i.test(f)) continue;
    const path = join(LOCAL_DIR, f);
    if (readFileSync(path, "utf8").includes(url)) return path;
  }
  return null;
}
