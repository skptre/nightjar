import type { Database, SqlValue } from './types';
import { isTauri } from '@/lib/platform';
import { runMigrations } from './migrations';
import schemaSQL from './schema.sql?raw';

type TauriDb = {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  close(): Promise<boolean>;
};

function convertParams(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index++;
    return `$${String(index)}`;
  });
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isReadQuery(sql: string): boolean {
  const trimmed = sql.trimStart().toUpperCase();
  return trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA');
}

export class TauriDatabase implements Database {
  private db: TauriDb;
  private inTransaction = false;

  private constructor(db: TauriDb) {
    this.db = db;
  }

  static async create(): Promise<TauriDatabase> {
    if (!isTauri()) {
      throw new Error('TauriDatabase can only be used in Tauri environment');
    }

    const mod = await import('@tauri-apps/plugin-sql');
    const TauriSqlDb = mod.default;
    const db = await TauriSqlDb.load('sqlite:nightjar.db') as TauriDb;
    const instance = new TauriDatabase(db);

    const tables = await instance.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    );

    if (tables.length === 0) {
      await instance.initSchema();
    }

    await runMigrations(instance);

    return instance;
  }

  private async initSchema(): Promise<void> {
    const statements = splitStatements(schemaSQL);
    for (const stmt of statements) {
      await this.db.execute(convertParams(stmt));
    }
  }

  async run(sql: string, params?: SqlValue[]): Promise<void> {
    const converted = convertParams(sql);
    await this.db.execute(converted, params ?? []);
  }

  async exec(sql: string): Promise<void> {
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      await this.db.execute(convertParams(stmt));
    }
  }

  async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    const converted = convertParams(sql);
    if (isReadQuery(sql)) {
      return this.db.select<T[]>(converted, params ?? []);
    }
    await this.db.execute(converted, params ?? []);
    return [];
  }

  async queryOne<T>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async transaction(fn: () => Promise<void>): Promise<void> {
    this.inTransaction = true;
    await this.db.execute('BEGIN');
    try {
      await fn();
      await this.db.execute('COMMIT');
    } catch (e) {
      await this.db.execute('ROLLBACK');
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
