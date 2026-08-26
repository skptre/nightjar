import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { loadDatabase, saveDatabase } from './indexeddb';
import { runMigrations } from './migrations';
import { isTauri } from '@/lib/platform';
import schemaSQL from './schema.sql?raw';
import type { Database, SqlValue } from './types';

export type { Database, SqlValue } from './types';

export class NightjarDB implements Database {
  private db: SqlJsDatabase;
  private readonly shouldPersist: boolean;
  private inTransaction = false;

  private constructor(db: SqlJsDatabase, shouldPersist: boolean) {
    this.db = db;
    this.shouldPersist = shouldPersist;
  }

  static async create(): Promise<NightjarDB> {
    const wasmBinary = await fetch('/sql-wasm.wasm').then(r => r.arrayBuffer());
    const SQL = await initSqlJs({ wasmBinary });

    const savedData = await loadDatabase();
    const sqlDb = savedData ? new SQL.Database(savedData) : new SQL.Database();
    const instance = new NightjarDB(sqlDb, true);

    if (!savedData) {
      instance.initSchema();
    }

    await runMigrations(instance);
    return instance;
  }

  static async createInMemory(): Promise<NightjarDB> {
    const SQL = await initSqlJs();
    const sqlDb = new SQL.Database();
    const instance = new NightjarDB(sqlDb, false);
    instance.initSchema();
    return instance;
  }

  static async createFromBytes(data: Uint8Array): Promise<NightjarDB> {
    const SQL = await initSqlJs();
    const sqlDb = new SQL.Database(data);
    const instance = new NightjarDB(sqlDb, false);
    await runMigrations(instance);
    return instance;
  }

  private initSchema(): void {
    this.db.exec(schemaSQL);
    void this.persist();
  }

  async run(sql: string, params?: SqlValue[]): Promise<void> {
    this.db.run(sql, params as Parameters<SqlJsDatabase['run']>[1]);
    if (!this.inTransaction) {
      void this.persist();
    }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
    if (!this.inTransaction) {
      void this.persist();
    }
  }

  async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      if (params) {
        stmt.bind(params as Parameters<typeof stmt.bind>[0]);
      }
      const results: T[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T);
      }
      return results;
    } finally {
      stmt.free();
    }
  }

  async queryOne<T>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async transaction(fn: () => Promise<void>): Promise<void> {
    this.inTransaction = true;
    this.db.run('BEGIN');
    try {
      await fn();
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    } finally {
      this.inTransaction = false;
    }
    void this.persist();
  }

  export(): Uint8Array {
    return new Uint8Array(this.db.export());
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private async persist(): Promise<void> {
    if (!this.shouldPersist) return;
    const data = this.db.export();
    await saveDatabase(new Uint8Array(data));
  }
}

export async function createDatabase(): Promise<Database> {
  if (isTauri()) {
    const { TauriDatabase } = await import('./tauri-database');
    const db = await TauriDatabase.create();
    const { migrateFromBrowser } = await import('./migrate-from-browser');
    await migrateFromBrowser(db);
    return db;
  }
  return NightjarDB.create();
}
