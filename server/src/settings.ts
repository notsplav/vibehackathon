// Настройки со страницы расширения: хранятся в SQLite поверх значений по умолчанию из .env.

import { z } from "zod";
import type { ServerSettings, SettingsOptions, SettingsResponse } from "../../shared/contract.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db/store.ts";
import { type Runtime, buildRuntime, listOptions } from "./runtime.ts";

const KEY = "server";

export function defaultSettings(config: Config): ServerSettings {
  return {
    provider: config.provider,
    model: config.provider === "ollama" ? config.ollamaModel : config.geminiModel,
    searchProvider: config.searchProvider,
    searxngEngines: null,
    queriesPerClaim: config.searchQueriesPerClaim,
  };
}

export function loadSettings(store: Store, config: Config): ServerSettings {
  const saved = store.getSetting<Partial<ServerSettings>>(KEY);
  const parsed = settingsSchema.safeParse({ ...defaultSettings(config), ...saved });
  return parsed.success ? parsed.data : defaultSettings(config);
}

export function saveSettings(store: Store, settings: ServerSettings): void {
  store.setSetting(KEY, settings);
}

const name = z.string().min(1).max(100).regex(/^[\w.:\-/ ]+$/);

export const settingsSchema = z.object({
  provider: z.enum(["gemini", "ollama"]),
  model: name,
  searchProvider: z.enum(["searxng", "ollama"]),
  searxngEngines: z.array(name).min(1).max(40).nullable(),
  queriesPerClaim: z.number().int().min(1).max(3),
});

/** Проверка выбора по доступным вариантам: модель и поисковики должны существовать. */
export function validateChoice(s: ServerSettings, options: SettingsOptions): string | null {
  const provider = options.providers.find((p) => p.id === s.provider);
  if (!provider?.available) return `Провайдер недоступен: ${provider?.note ?? s.provider}`;
  const models = options.models[s.provider];
  if (models.length > 0 && !models.includes(s.model)) return `Модель «${s.model}» недоступна у провайдера ${s.provider}.`;
  if (s.provider === "ollama") {
    const search = options.searchProviders.find((p) => p.id === s.searchProvider);
    if (!search?.available) return `Поиск недоступен: ${search?.note ?? s.searchProvider}`;
    if (s.searchProvider === "searxng" && s.searxngEngines && options.searxngEngines.length > 0) {
      const known = new Set(options.searxngEngines.map((e) => e.name));
      const unknown = s.searxngEngines.filter((e) => !known.has(e));
      if (unknown.length) return `Неизвестные поисковики SearXNG: ${unknown.join(", ")}.`;
    }
  }
  return null;
}

/** Что HTTP-слою нужно от настроек: текущая конфигурация, варианты для страницы и сохранение. */
export interface SettingsPort {
  current(): Pick<Runtime, "provider" | "model" | "searchName" | "engine" | "problem">;
  describe(): Promise<SettingsResponse>;
  update(next: ServerSettings): Promise<{ ok: true; response: SettingsResponse } | { ok: false; error: string }>;
}

export class SettingsService implements SettingsPort {
  private runtime: Runtime;
  private readonly store: Store;
  private readonly config: Config;
  private readonly fetch: typeof fetch;
  private readonly onChange: (rt: Runtime) => void;

  constructor(store: Store, config: Config, onChange: (rt: Runtime) => void = () => {}, f: typeof fetch = fetch) {
    this.store = store;
    this.config = config;
    this.fetch = f;
    this.onChange = onChange;
    this.runtime = buildRuntime(config, loadSettings(store, config), f);
  }

  current(): Runtime {
    return this.runtime;
  }

  async describe(): Promise<SettingsResponse> {
    return { settings: this.runtime.settings, options: await listOptions(this.config, this.fetch) };
  }

  async update(next: ServerSettings): Promise<{ ok: true; response: SettingsResponse } | { ok: false; error: string }> {
    const options = await listOptions(this.config, this.fetch);
    const error = validateChoice(next, options);
    if (error) return { ok: false, error };
    saveSettings(this.store, next);
    this.runtime = buildRuntime(this.config, next, this.fetch);
    this.onChange(this.runtime);
    return { ok: true, response: { settings: next, options } };
  }
}
