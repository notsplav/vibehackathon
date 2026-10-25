// Проверка локальной Ollama и выбранного поиска (SearXNG или Ollama Web Search): npm run probe:ollama. Ключ не печатается.

import { loadConfig } from "../src/config.ts";
import { classifyError } from "../src/llm/errors.ts";
import { OllamaFactChecker, ollamaProblem } from "../src/ollama/client.ts";
import { OllamaWebSearch } from "../src/search/ollama.ts";
import { SearxngSearch } from "../src/search/searxng.ts";

const config = loadConfig({ ...process.env, LLM_PROVIDER: "ollama" });
const retry = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
const search =
  config.searchProvider === "searxng"
    ? new SearxngSearch({ baseUrl: config.searxngUrl, retry, perQuery: 5 })
    : new OllamaWebSearch({ apiKey: config.ollamaApiKey, retry, perQuery: 5 });
const opts = { host: config.ollamaUrl, model: config.model, numCtx: config.ollamaNumCtx, search, queriesPerClaim: config.searchQueriesPerClaim, retry };
console.log(`ollama: ${opts.host} model: ${opts.model} search: ${search.name}${search.name === "searxng" ? ` (${config.searxngUrl})` : ""}`);

const problem = await ollamaProblem(opts);
if (problem) console.warn(`проблема: ${problem}`);

const checker = new OllamaFactChecker(opts);
const report = (stage: string, e: unknown) => {
  const err = classifyError(e, config.ollamaApiKey);
  console.error(`${stage}: ОШИБКА ${err.kind} ${(err.userText ?? err.message).slice(0, 200)}`);
};

let t = Date.now();
try {
  const text = await checker.chat("Отвечай JSON.", "Верни {\"ok\": true}", { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
  console.log(`модель: ответ за ${Date.now() - t} мс: ${text.slice(0, 80)}`);
} catch (e) {
  report("модель", e);
}

t = Date.now();
try {
  const results = await search.search("Мария Склодовская-Кюри дата рождения");
  console.log(`поиск: ${results.length} результатов за ${Date.now() - t} мс`);
  for (const r of results.slice(0, 3)) console.log(`   ${r.url} — ${(r.title ?? "").slice(0, 60)}`);
} catch (e) {
  report("поиск", e);
}
