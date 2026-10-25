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
];
