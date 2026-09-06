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
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS gmail_suggestions (
        id            TEXT PRIMARY KEY,
        email_id      TEXT NOT NULL,
        signal_type   TEXT NOT NULL CHECK (
          signal_type IN ('interview', 'offer', 'rejection', 'assessment')
        ),
        company_slug  TEXT NOT NULL,
        company_name  TEXT NOT NULL,
        posting_id    TEXT NOT NULL,
        sender_domain TEXT NOT NULL,
        subject       TEXT NOT NULL,
        received_at   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (
          status IN ('pending', 'accepted', 'dismissed')
        ),
        created_at    TEXT NOT NULL,
        FOREIGN KEY (posting_id) REFERENCES applications(posting_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_suggestions_email
        ON gmail_suggestions(email_id);
      CREATE INDEX IF NOT EXISTS idx_gmail_suggestions_status
        ON gmail_suggestions(status);
      CREATE INDEX IF NOT EXISTS idx_gmail_suggestions_posting
        ON gmail_suggestions(posting_id);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE postings_cache ADD COLUMN description_attempted_at TEXT;
      ALTER TABLE postings_cache ADD COLUMN description_error TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE postings_cache ADD COLUMN role_classification TEXT;
      ALTER TABLE postings_cache ADD COLUMN classification_version INTEGER;
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
    await db.transaction(async (transaction) => {
      await transaction.exec(migration.sql);
      await transaction.run('UPDATE schema_version SET version = ?', [migration.version]);
    });
  }
}

export async function getSchemaVersion(db: Database): Promise<number> {
  const row = await db.queryOne<{ version: number }>('SELECT version FROM schema_version');
  return row?.version ?? 0;
}
