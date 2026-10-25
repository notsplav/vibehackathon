// Миграции схемы SQLite. Уже применённые миграции не редактируются: изменения — только новой записью в конце списка.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
      CREATE TABLE analyses (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        canonical_url TEXT,
        cache_url TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        algorithm_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        metadata_json TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX analyses_cache ON analyses (cache_url, text_hash, algorithm_version);

      CREATE TABLE blocks (
        analysis_id TEXT NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
        block_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        links_json TEXT NOT NULL,
        PRIMARY KEY (analysis_id, block_id)
      );

      CREATE TABLE claims (
        analysis_id TEXT NOT NULL REFERENCES analyses (id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        normalized_claim TEXT NOT NULL,
        exact_text TEXT NOT NULL,
        occurrences_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        verdict TEXT,
        explanation TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        checked_at TEXT,
        PRIMARY KEY (analysis_id, claim_id)
      );

      CREATE TABLE evidence (
        analysis_id TEXT NOT NULL,
        claim_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        retrieved_at TEXT NOT NULL,
        role TEXT NOT NULL,
        relation TEXT,
        interaction_id TEXT,
        annotation_index INTEGER NOT NULL,
        PRIMARY KEY (analysis_id, claim_id, idx),
        FOREIGN KEY (analysis_id, claim_id) REFERENCES claims (analysis_id, claim_id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 2,
    name: "analysis_engine",
    // Провайдер и модель входят в ключ кэша: результат одной модели не выдаётся за результат другой.
    sql: `
      ALTER TABLE analyses ADD COLUMN engine TEXT NOT NULL DEFAULT '';
      CREATE INDEX analyses_cache_engine ON analyses (cache_url, text_hash, algorithm_version, engine);
    `,
  },
  {
    version: 3,
    name: "claim_reuse",
    // Одинаковое утверждение, уже проверенное той же моделью, не проверяется повторно (кроме «Повторить анализ»).
    sql: `
      ALTER TABLE claims ADD COLUMN claim_key TEXT NOT NULL DEFAULT '';
      CREATE INDEX claims_reuse ON claims (claim_key, status, checked_at);
      ALTER TABLE analyses ADD COLUMN fresh INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 4,
    name: "claim_search_queries",
    // Запросы, составленные при извлечении утверждений: проверка не тратит на них отдельный вызов модели,
    // в том числе после перезапуска сервера.
    sql: `ALTER TABLE claims ADD COLUMN search_queries_json TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    version: 5,
    name: "settings",
    // Настройки со страницы расширения; поверх значений по умолчанию из .env. Ключи API сюда не пишутся.
    sql: `CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  },
  {
    version: 6,
    name: "analysis_focus",
    // Проверка выделенного фрагмента: какие блоки и какой текст выделены (null — вся статья).
    sql: `ALTER TABLE analyses ADD COLUMN focus_json TEXT;`,
  },
];
