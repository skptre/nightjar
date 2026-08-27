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
    await db.exec(migration.sql);
    await db.run('UPDATE schema_version SET version = ?', [migration.version]);
  }
}

export async function getSchemaVersion(db: Database): Promise<number> {
  const row = await db.queryOne<{ version: number }>('SELECT version FROM schema_version');
  return row?.version ?? 0;
}
