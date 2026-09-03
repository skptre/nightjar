import type { Database } from './types';

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS companies_meta (
        slug         TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        typical_open TEXT
      );
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE postings_cache ADD COLUMN category_tags TEXT;
      UPDATE postings_cache SET category = 'data-ml' WHERE category = 'ml';
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE applications ADD COLUMN outcome TEXT;
      ALTER TABLE applications ADD COLUMN outcome_at TEXT;
      ALTER TABLE applications ADD COLUMN interview_rounds INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE applications ADD COLUMN outcome_notes TEXT;

      CREATE TABLE IF NOT EXISTS application_outcome_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        posting_id       TEXT NOT NULL,
        outcome          TEXT NOT NULL CHECK (
          outcome IN ('interview', 'offer', 'rejection', 'ghosted', 'withdrawn')
        ),
        occurred_at      TEXT NOT NULL,
        interview_rounds INTEGER NOT NULL DEFAULT 0,
        notes            TEXT,
        FOREIGN KEY (posting_id) REFERENCES applications(posting_id)
      );

      CREATE TABLE IF NOT EXISTS recalibration_suggestion_actions (
        suggestion_id TEXT PRIMARY KEY,
        status        TEXT NOT NULL CHECK (status IN ('applied', 'dismissed')),
        acted_at      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outcome_events_posting
        ON application_outcome_events(posting_id, occurred_at);
    `,
  },
];

export async function runMigrations(
  db: Database,
  migrations: Migration[] = MIGRATIONS,
): Promise<void> {
  const row = await db.queryOne<{ version: number }>('SELECT version FROM schema_version');
  const currentVersion = row?.version ?? 0;

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await db.transaction(async () => {
      await db.exec(migration.sql);
      await db.run('UPDATE schema_version SET version = ?', [migration.version]);
    });
  }
}

export async function getSchemaVersion(db: Database): Promise<number> {
  const row = await db.queryOne<{ version: number }>('SELECT version FROM schema_version');
  return row?.version ?? 0;
}
