import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { loadDatabase, saveDatabase } from './indexeddb';
import { runMigrations } from './migrations';
import schemaSQL from './schema.sql?raw';

export type SqlValue = string | number | Uint8Array | null;

export class NightjarDB {
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

    runMigrations(instance);
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
    runMigrations(instance);
    return instance;
  }

  private initSchema(): void {
    this.db.exec(schemaSQL);
    void this.persist();
  }

  run(sql: string, params?: SqlValue[]): void {
    this.db.run(sql, params);
    if (!this.inTransaction) {
      void this.persist();
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
    if (!this.inTransaction) {
      void this.persist();
    }
  }

  query<T>(sql: string, params?: SqlValue[]): T[] {
    const stmt = this.db.prepare(sql);
    try {
      if (params) {
        stmt.bind(params);
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

  queryOne<T>(sql: string, params?: SqlValue[]): T | undefined {
    const rows = this.query<T>(sql, params);
    return rows[0];
  }

  transaction(fn: () => void): void {
    this.inTransaction = true;
    this.db.run('BEGIN');
    try {
      fn();
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

  close(): void {
    this.db.close();
  }

  private async persist(): Promise<void> {
    if (!this.shouldPersist) return;
    const data = this.db.export();
    await saveDatabase(new Uint8Array(data));
  }
}
