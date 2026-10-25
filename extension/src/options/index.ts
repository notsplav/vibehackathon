// Страница настроек «Сверки» (chrome://extensions → Параметры или шестерёнка в панели).
// Настройки хранит локальный сервер; ключи API здесь не вводятся — они только в .env сервера.

import type { LlmProvider, SearchProviderId, ServerSettings, SettingsChoice, SettingsResponse } from "../../../shared/contract.ts";
import { SETTINGS_CHANGED } from "../messages.ts";
import { api } from "../sidepanel/api.ts";

const root = document.getElementById("app")!;
let data: SettingsResponse | null = null;
let draft: ServerSettings | null = null;
let status: { text: string; kind: "ok" | "error" | "info" } | null = null;
let saving = false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function radioGroup<T extends string>(name: string, choices: SettingsChoice<T>[], value: T, onChange: (v: T) => void): HTMLElement {
  const group = h("div", "choices");
  group.setAttribute("role", "radiogroup");
  for (const c of choices) {
    const label = h("label", `choice${c.available ? "" : " is-disabled"}${c.id === value ? " is-selected" : ""}`);
    const input = h("input");
    input.type = "radio";
    input.name = name;
    input.value = c.id;
    input.checked = c.id === value;
    input.disabled = !c.available && c.id !== value;
    input.addEventListener("change", () => onChange(c.id));
    const body = h("span", "choice-body");
    body.append(h("span", "choice-label", c.label));
    if (c.note) body.append(h("span", "choice-note", c.note));
    label.append(input, body);
    group.append(label);
  }
  return group;
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  const s = h("section", "card");
  s.append(h("h2", undefined, title));
  for (const c of children) if (c) s.append(c);
  return s;
}

/** Подпись и элемент управления. Обёртка — <div>: внутри бывает несколько флажков, и <label> переключал бы первый. */
function field(label: string, control: HTMLElement): HTMLElement {
  const f = h("div", "field");
  f.setAttribute("role", "group");
  f.setAttribute("aria-label", label);
  f.append(h("span", "field-label", label), control);
  if (control instanceof HTMLSelectElement) control.setAttribute("aria-label", label);
  return f;
}

function modelSelect(models: string[], value: string, onChange: (v: string) => void): HTMLElement {
  if (models.length === 0) return h("p", "muted", "Список моделей недоступен — см. пояснение выше.");
  const select = h("select");
  // Сохранённая модель могла пропасть из списка (например, удалена в Ollama) — показываем её, но помечаем.
  const list = models.includes(value) ? models : [value, ...models];
  for (const m of list) {
    const o = h("option", undefined, models.includes(m) ? m : `${m} (недоступна)`);
    o.value = m;
    o.selected = m === value;
    select.append(o);
  }
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function enginesBox(d: SettingsResponse, s: ServerSettings): HTMLElement {
  const engines = d.options.searxngEngines;
  if (engines.length === 0) return h("p", "muted", "Список поисковиков недоступен: SearXNG не отвечает.");
  const selected = new Set(s.searxngEngines ?? engines.filter((e) => e.enabledByDefault).map((e) => e.name));
  const box = h("div", "engines");
  for (const e of engines) {
    const label = h("label", "engine");
    const input = h("input");
    input.type = "checkbox";
    input.checked = selected.has(e.name);
    input.addEventListener("change", () => {
      input.checked ? selected.add(e.name) : selected.delete(e.name);
      update({ searxngEngines: selected.size ? engines.map((x) => x.name).filter((n) => selected.has(n)) : [] });
    });
    label.append(input, h("span", undefined, e.name));
    box.append(label);
  }
  const wrap = h("div");
  wrap.append(box);
  const footer = h("div", "engines-footer");
  footer.append(h("span", "muted", s.searxngEngines ? `Выбрано: ${s.searxngEngines.length}` : "Как в настройках SearXNG"));
  if (s.searxngEngines) {
    const reset = h("button", "link", "Сбросить");
    reset.type = "button";
    reset.addEventListener("click", () => update({ searxngEngines: null }));
    footer.append(reset);
  }
  wrap.append(footer);
  return wrap;
}

function segmented(values: number[], value: number, onChange: (v: number) => void): HTMLElement {
  const group = h("div", "segmented");
  for (const v of values) {
    const b = h("button", v === value ? "is-selected" : "", String(v));
    b.type = "button";
    b.setAttribute("aria-pressed", String(v === value));
    b.addEventListener("click", () => onChange(v));
    group.append(b);
  }
  return group;
}

function update(patch: Partial<ServerSettings>): void {
  if (!draft) return;
  draft = { ...draft, ...patch };
  status = null;
  render();
}

function selectProvider(p: LlmProvider): void {
  if (!data || !draft) return;
  const models = data.options.models[p];
  // При смене провайдера — его первая доступная модель, если текущей у него нет.
  update({ provider: p, model: models.includes(draft.model) ? draft.model : (models[0] ?? draft.model) });
}

function dirty(): boolean {
  return !!data && !!draft && JSON.stringify(data.settings) !== JSON.stringify(draft);
}

function invalid(): string | null {
  if (!draft || !data) return null;
  if (draft.provider === "ollama" && draft.searchProvider === "searxng" && draft.searxngEngines?.length === 0) return "Выберите хотя бы один поисковик.";
  if (data.options.models[draft.provider].length > 0 && !data.options.models[draft.provider].includes(draft.model)) return "Выберите доступную модель.";
  return null;
}

async function save(): Promise<void> {
  if (!draft) return;
  saving = true;
  render();
  try {
    data = await api.saveSettings(draft);
    draft = structuredClone(data.settings);
    status = { text: "Сохранено. Новые проверки пойдут с этими настройками.", kind: "ok" };
    void chrome.runtime.sendMessage({ type: SETTINGS_CHANGED }).catch(() => undefined);
  } catch (e) {
    status = { text: e instanceof Error ? e.message : String(e), kind: "error" };
  }
  saving = false;
  render();
}

function render(): void {
  if (!data || !draft) {
    root.replaceChildren(h("p", status?.kind === "error" ? "error" : "muted", status?.text ?? "Загружаем настройки…"));
    return;
  }
  const d = data;
  const s = draft;
  const model = section(
    "Модель",
    radioGroup<LlmProvider>("provider", d.options.providers, s.provider, selectProvider),
    field("Модель", modelSelect(d.options.models[s.provider], s.model, (m) => update({ model: m }))),
  );
  const search =
    s.provider === "gemini"
      ? section("Поиск источников", h("p", "muted", "Gemini ищет источники через встроенный Google Search."))
      : section(
          "Поиск источников",
          radioGroup<SearchProviderId>("search", d.options.searchProviders, s.searchProvider, (v) => update({ searchProvider: v })),
          s.searchProvider === "searxng" ? field("Поисковики SearXNG", enginesBox(d, s)) : null,
          field("Запросов на утверждение", segmented([1, 2, 3], s.queriesPerClaim, (v) => update({ queriesPerClaim: v }))),
        );

  const actions = h("div", "actions");
  const problem = invalid();
  const saveBtn = h("button", "primary", saving ? "Сохраняем…" : "Сохранить");
  saveBtn.type = "button";
  saveBtn.disabled = saving || !dirty() || !!problem;
  saveBtn.addEventListener("click", () => void save());
  actions.append(saveBtn);
  const note = problem ? { text: problem, kind: "error" as const } : status;
  if (note) actions.append(h("span", `status ${note.kind}`, note.text));

  root.replaceChildren(model, search, actions, h("p", "footnote", "Ключи API (GEMINI_API_KEY, OLLAMA_API_KEY) задаются только в .env сервера."));
}

async function load(): Promise<void> {
  try {
    data = await api.settings();
    draft = structuredClone(data.settings);
    status = null;
  } catch (e) {
    status = { text: e instanceof Error ? e.message : String(e), kind: "error" };
  }
  render();
}

render();
void load();
