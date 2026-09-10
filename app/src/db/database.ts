import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { loadDatabase, saveDatabase } from './indexeddb';
import { runMigrations } from './migrations';
import { isTauri } from '@/lib/platform';
import schemaSQL from './schema.sql?raw';
import type { Database, DatabaseTransaction, SqlStatement, SqlValue } from './types';

export type { Database, SqlValue } from './types';

export class NightjarDB implements Database {
  private db: SqlJsDatabase;
  private readonly shouldPersist: boolean;
  private operationTail: Promise<void> = Promise.resolve();

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
      await instance.initSchema();
    }

    await runMigrations(instance);
    return instance;
  }

  static async createInMemory(): Promise<NightjarDB> {
    const SQL = await initSqlJs();
    const sqlDb = new SQL.Database();
    const instance = new NightjarDB(sqlDb, false);
    await instance.initSchema();
    return instance;
  }

  static async createFromBytes(data: Uint8Array): Promise<NightjarDB> {
    const SQL = await initSqlJs();
    const sqlDb = new SQL.Database(data);
    const instance = new NightjarDB(sqlDb, false);
    await runMigrations(instance);
    return instance;
  }

  private async initSchema(): Promise<void> {
    this.db.exec(schemaSQL);
    await this.persist();
  }

  async run(sql: string, params?: SqlValue[]): Promise<void> {
    await this.enqueue(async () => {
      this.runDirect(sql, params);
      await this.persist();
    });
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(async () => {
      this.db.exec(sql);
      await this.persist();
    });
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    if (statements.length === 0) return;

    await this.transaction(async (transaction) => {
      await transaction.batch(statements);
    });
  }

  async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return this.enqueue(async () => this.queryDirect<T>(sql, params));
  }

  private queryDirect<T>(sql: string, params?: SqlValue[]): T[] {
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

  async transaction(fn: (transaction: DatabaseTransaction) => Promise<void>): Promise<void> {
    await this.enqueue(async () => {
      const transaction: DatabaseTransaction = {
        run: async (sql, params) => this.runDirect(sql, params),
        exec: async (sql) => { this.db.exec(sql); },
        batch: async (statements) => {
          for (const statement of statements) {
            if (statement.params) this.runDirect(statement.sql, statement.params);
            else this.db.exec(statement.sql);
          }
        },
        query: async <T>(sql: string, params?: SqlValue[]) => this.queryDirect<T>(sql, params),
        queryOne: async <T>(sql: string, params?: SqlValue[]) => {
          const rows = this.queryDirect<T>(sql, params);
          return rows[0];
        },
      };

      this.db.run('BEGIN');
      try {
        await fn(transaction);
        this.db.run('COMMIT');
      } catch (error) {
        this.db.run('ROLLBACK');
        throw error;
      }
      await this.persist();
    });
  }

  export(): Uint8Array {
    return new Uint8Array(this.db.export());
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.db.close();
    });
  }

  private async persist(): Promise<void> {
    if (!this.shouldPersist) return;
    const data = this.db.export();
    await saveDatabase(new Uint8Array(data));
  }

  private runDirect(sql: string, params?: SqlValue[]): void {
    this.db.run(sql, params as Parameters<SqlJsDatabase['run']>[1]);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

let openingDatabase: Promise<Database> | undefined;

export function createDatabase(): Promise<Database> {
  // StrictMode mounts providers twice. Both callers must share schema initialization.
  openingDatabase ??= openDatabase().finally(() => { openingDatabase = undefined; });
  return openingDatabase;
}

async function openDatabase(): Promise<Database> {
  if (isTauri()) {
    const { TauriDatabase } = await import('./tauri-database');
    const db = await TauriDatabase.create();
    const { migrateFromBrowser } = await import('./migrate-from-browser');
    await migrateFromBrowser(db);
    return db;
  }
  return NightjarDB.create();
}
