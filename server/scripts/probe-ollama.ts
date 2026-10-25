// Проверка локальной Ollama и Ollama Web Search: npm run probe:ollama. Ключ не печатается.

import { loadConfig } from "../src/config.ts";
import { classifyError } from "../src/llm/errors.ts";
import { OllamaFactChecker, ollamaProblem } from "../src/ollama/client.ts";

const config = loadConfig({ ...process.env, LLM_PROVIDER: "ollama" });
const opts = { host: config.ollamaUrl, model: config.model, apiKey: config.ollamaApiKey, numCtx: config.ollamaNumCtx, retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 } };
console.log(`ollama: ${opts.host} model: ${opts.model} web search key: ${opts.apiKey ? "задан" : "НЕ задан"}`);

const problem = await ollamaProblem(opts);
if (problem) console.warn(`проблема: ${problem}`);

const checker = new OllamaFactChecker(opts);
const report = (stage: string, e: unknown) => {
  const err = classifyError(e, opts.apiKey);
  console.error(`${stage}: ОШИБКА ${err.kind} ${err.message.slice(0, 200)}`);
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
  const results = await checker.search("Мария Склодовская-Кюри дата рождения");
  console.log(`поиск: ${results.length} результатов за ${Date.now() - t} мс`);
  for (const r of results.slice(0, 3)) console.log(`   ${String(r.url)} — ${String(r.title ?? "").slice(0, 60)}`);
} catch (e) {
  report("поиск", e);
}
