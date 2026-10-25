// Точка входа локального сервера: npm run dev:server.

import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { GeminiFactChecker } from "./gemini/client.ts";
import { createApp } from "./http.ts";
import type { FactChecker } from "./llm/types.ts";
import { DEFAULT_RETRY } from "./llm/retry.ts";
import { OllamaFactChecker, ollamaProblem } from "./ollama/client.ts";
import { OllamaWebSearch } from "./search/ollama.ts";
import { SearxngSearch } from "./search/searxng.ts";
import { AnalysisRunner } from "./pipeline/runner.ts";

const config = loadConfig();
const store = new Store(config.dbPath);
const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };

let checker: FactChecker | null;
let problem: () => Promise<string | null>;
let secret: string | null;
if (config.provider === "ollama") {
  const perQuery = 5;
  const search =
    config.searchProvider === "searxng"
      ? new SearxngSearch({ baseUrl: config.searxngUrl, retry: DEFAULT_RETRY, perQuery })
      : new OllamaWebSearch({ apiKey: config.ollamaApiKey, retry: DEFAULT_RETRY, perQuery });
  const opts = { host: config.ollamaUrl, model: config.model, numCtx: config.ollamaNumCtx, search, queriesPerClaim: config.searchQueriesPerClaim };
  checker = new OllamaFactChecker(opts);
  problem = () => ollamaProblem(opts);
  secret = config.ollamaApiKey;
} else {
  checker = config.geminiApiKey ? new GeminiFactChecker(config.geminiApiKey, config.model) : null;
  problem = async () => (config.geminiApiKey ? null : "GEMINI_API_KEY не задан: проверка утверждений недоступна.");
  secret = config.geminiApiKey;
}

const runner = new AnalysisRunner(
  store,
  checker,
  { provider: config.provider, concurrency: config.checkConcurrency, chunkChars: config.chunkChars, apiKey: secret, reuseHours: config.claimReuseHours },
  log,
);

runner.resumeAll();
createApp({ config, store, runner, problem }).listen(config.port, config.host, async () => {
  const searchInfo = config.provider === "ollama" ? ` search=${config.searchProvider}${config.searchProvider === "searxng" ? `(${config.searxngUrl})` : ""} queries/claim=${config.searchQueriesPerClaim}` : "";
  log.info(`server: http://${config.host}:${config.port} provider=${config.provider} model=${config.model}${searchInfo} db=${config.dbPath}`);
  const p = await problem();
  if (p) log.warn(p);
});
