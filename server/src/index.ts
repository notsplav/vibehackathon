// Точка входа локального сервера: npm run dev:server.

import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { GeminiFactChecker } from "./gemini/client.ts";
import { createApp } from "./http.ts";
import { AnalysisRunner } from "./pipeline/runner.ts";

const config = loadConfig();
const store = new Store(config.dbPath);
const checker = config.geminiApiKey ? new GeminiFactChecker(config.geminiApiKey, config.model) : null;
const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };
const runner = new AnalysisRunner(store, checker, { concurrency: config.checkConcurrency, chunkChars: config.chunkChars, apiKey: config.geminiApiKey }, log);

if (!checker) log.warn("GEMINI_API_KEY не задан: анализы будут завершаться ошибкой конфигурации.");
if (config.allowedOrigins.length === 0) log.warn("ALLOWED_ORIGINS не задан: принимаются запросы от любого chrome-extension://.");

runner.resumeAll();
createApp({ config, store, runner }).listen(config.port, config.host, () => {
  log.info(`server: http://${config.host}:${config.port} model=${config.model} db=${config.dbPath}`);
});
