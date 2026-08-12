import type { NightjarDB } from './database';

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [];

export function runMigrations(
  db: NightjarDB,
  migrations: Migration[] = MIGRATIONS,
): void {
  const row = db.queryOne<{ version: number }>('SELECT version FROM schema_version');
  const currentVersion = row?.version ?? 0;

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.exec(migration.sql);
    db.run('UPDATE schema_version SET version = ?', [migration.version]);
  }
}

export function getSchemaVersion(db: NightjarDB): number {
  const row = db.queryOne<{ version: number }>('SELECT version FROM schema_version');
  return row?.version ?? 0;
}
