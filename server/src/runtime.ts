// Сборка рабочей конфигурации (модель, поиск, параллелизм) из .env и сохранённых настроек.
// После сохранения настроек новые анализы идут уже с новой конфигурацией; идущие доработают со старой.

import { GoogleGenAI } from "@google/genai";
import type { LlmProvider, ServerSettings, SettingsOptions } from "../../shared/contract.ts";
import type { Config } from "./config.ts";
import { GeminiFactChecker } from "./gemini/client.ts";
import { DEFAULT_RETRY } from "./llm/retry.ts";
import type { FactChecker } from "./llm/types.ts";
import { OllamaFactChecker, ollamaProblem } from "./ollama/client.ts";
import { OllamaWebSearch } from "./search/ollama.ts";
import { SearxngSearch, searxngEngines } from "./search/searxng.ts";

const RESULTS_PER_QUERY = 5;

export interface Runtime {
  settings: ServerSettings;
  provider: LlmProvider;
  model: string;
  checker: FactChecker | null;
  /** Секрет, который вырезается из сообщений об ошибках. */
  secret: string | null;
  concurrency: number;
  /** Название поиска для пользователя. */
  searchName: string;
  /** Провайдер и модель — часть ключа кэша результатов. */
  engine: string;
  problem(): Promise<string | null>;
}

export function buildRuntime(config: Config, settings: ServerSettings, f: typeof fetch = fetch): Runtime {
  const concurrency = config.checkConcurrency ?? (settings.provider === "ollama" ? 1 : 2);
  const base = { settings, provider: settings.provider, model: settings.model, concurrency, engine: `${settings.provider}:${settings.model}` };
  if (settings.provider === "ollama") {
    const search =
      settings.searchProvider === "searxng"
        ? new SearxngSearch({ baseUrl: config.searxngUrl, retry: DEFAULT_RETRY, perQuery: RESULTS_PER_QUERY, engines: settings.searxngEngines, fetch: f })
        : new OllamaWebSearch({ apiKey: config.ollamaApiKey, retry: DEFAULT_RETRY, perQuery: RESULTS_PER_QUERY, fetch: f });
    const opts = { host: config.ollamaUrl, model: settings.model, numCtx: config.ollamaNumCtx, search, queriesPerClaim: settings.queriesPerClaim, fetch: f };
    return {
      ...base,
      checker: new OllamaFactChecker(opts),
      secret: config.ollamaApiKey,
      searchName: settings.searchProvider === "searxng" ? "SearXNG" : "Ollama Web Search",
      problem: () => ollamaProblem(opts),
    };
  }
  return {
    ...base,
    checker: config.geminiApiKey ? new GeminiFactChecker(config.geminiApiKey, settings.model) : null,
    secret: config.geminiApiKey,
    searchName: "Google Search",
    problem: async () => (config.geminiApiKey ? null : "GEMINI_API_KEY не задан: проверка утверждений недоступна."),
  };
}

// --- Варианты для страницы настроек ---

let geminiCache: { at: number; models: string[] } | null = null;
const GEMINI_CACHE_MS = 10 * 60_000;
/** Текстовые модели Gemini; озвучка, картинки, live и эмбеддинги не подходят для проверки. */
const GEMINI_SKIP = /tts|image|live|embedding|transcribe|customtools|aqa|learnlm|gemma/i;

async function geminiModels(apiKey: string): Promise<string[]> {
  if (geminiCache && Date.now() - geminiCache.at < GEMINI_CACHE_MS) return geminiCache.models;
  const models: string[] = [];
  for await (const m of await new GoogleGenAI({ apiKey }).models.list()) {
    const name = m.name?.replace(/^models\//, "") ?? "";
    if (name.startsWith("gemini-") && !GEMINI_SKIP.test(name)) models.push(name);
  }
  models.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  geminiCache = { at: Date.now(), models };
  return models;
}

async function ollamaModels(host: string, f: typeof fetch): Promise<string[] | null> {
  try {
    const res = await f(new URL("/api/tags", host), { signal: AbortSignal.timeout(2000) });
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean).sort();
  } catch {
    return null;
  }
}

export async function listOptions(config: Config, f: typeof fetch = fetch): Promise<SettingsOptions> {
  const [ollama, gemini, searxngProblem, engines] = await Promise.all([
    ollamaModels(config.ollamaUrl, f),
    config.geminiApiKey ? geminiModels(config.geminiApiKey).catch(() => null) : Promise.resolve(null),
    new SearxngSearch({ baseUrl: config.searxngUrl, retry: DEFAULT_RETRY, perQuery: 1, fetch: f }).problem(),
    searxngEngines(config.searxngUrl, f),
  ]);
  return {
    providers: [
      {
        id: "ollama",
        label: "Ollama (локальная модель)",
        available: !!ollama && ollama.length > 0,
        note: !ollama ? `Ollama не запущена на ${config.ollamaUrl}: выполните ollama serve.` : ollama.length === 0 ? "Нет скачанных моделей: ollama pull qwen3:14b." : null,
      },
      {
        id: "gemini",
        label: "Gemini API",
        available: !!config.geminiApiKey,
        note: !config.geminiApiKey ? "GEMINI_API_KEY не задан в .env сервера." : gemini === null ? "Не удалось получить список моделей Gemini." : null,
      },
    ],
    models: { ollama: ollama ?? [], gemini: gemini ?? [] },
    searchProviders: [
      { id: "searxng", label: "SearXNG (локально)", available: searxngProblem === null, note: searxngProblem },
      { id: "ollama", label: "Ollama Web Search", available: !!config.ollamaApiKey, note: config.ollamaApiKey ? null : "OLLAMA_API_KEY не задан в .env сервера." },
    ],
    searxngEngines: engines,
  };
}
