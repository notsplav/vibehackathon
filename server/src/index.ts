// Точка входа локального сервера: npm run dev:server.

import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { createApp } from "./http.ts";
import { AnalysisRunner } from "./pipeline/runner.ts";
import type { Runtime } from "./runtime.ts";
import { SettingsService } from "./settings.ts";

const config = loadConfig();
const store = new Store(config.dbPath);
const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };

function describe(rt: Runtime): string {
  const s = rt.settings;
  const search = s.provider === "ollama" ? ` search=${rt.searchName}${s.searxngEngines ? `(${s.searxngEngines.join(",")})` : ""} queries/claim=${s.queriesPerClaim}` : "";
  return `provider=${rt.provider} model=${rt.model}${search}`;
}

// Модель и поиск задаются .env и страницей настроек расширения; новые анализы идут с текущими настройками.
const settings = new SettingsService(store, config, (rt) => log.info(`settings: ${describe(rt)}`));
const runner = new AnalysisRunner(
  store,
  () => {
    const rt = settings.current();
    return { provider: rt.provider, checker: rt.checker, secret: rt.secret, concurrency: rt.concurrency };
  },
  { chunkChars: config.chunkChars, reuseHours: config.claimReuseHours },
  log,
);

runner.resumeAll();
createApp({ config, store, runner, settings }).listen(config.port, config.host, async () => {
  const rt = settings.current();
  log.info(`server: http://${config.host}:${config.port} ${describe(rt)} db=${config.dbPath}`);
  const p = await rt.problem();
  if (p) log.warn(p);
});
