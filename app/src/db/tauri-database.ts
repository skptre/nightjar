import type { Database, DatabaseTransaction, SqlStatement, SqlValue } from './types';
import { isTauri } from '@/lib/platform';
import { runMigrations } from './migrations';
import schemaSQL from './schema.sql?raw';

const NIGHTJAR_DB = 'sqlite:nightjar.db';

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
  return trimmed.startsWith('SELECT');
}

function serializeValue(value: SqlValue): string | number | null | { blob: number[] } {
  return value instanceof Uint8Array ? { blob: Array.from(value) } : value;
}

export class TauriDatabase implements Database {
  private operationTail: Promise<void> = Promise.resolve();

  private constructor() {}

  static async create(): Promise<TauriDatabase> {
    if (!isTauri()) {
      throw new Error('TauriDatabase can only be used in Tauri environment');
    }

    const instance = new TauriDatabase();

    const tables = await instance.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    );

    if (tables.length === 0) {
      await instance.initSchema();
    }

    const { getSchemaVersion, MIGRATIONS } = await import('./migrations');
    const version = await getSchemaVersion(instance);
    if (version < Math.max(...MIGRATIONS.map(m => m.version))) {
      const { invoke } = await import('@tauri-apps/api/core');
      const { readWorkspaceSettings } = await import('@/backup/workspace');
      await invoke('backup_before_migration', { version, settings: JSON.stringify(readWorkspaceSettings()) });
    }
    await runMigrations(instance);

    return instance;
  }

  private async initSchema(): Promise<void> {
    await this.executeBatch(splitStatements(schemaSQL).map((sql) => ({ sql })));
  }

  async run(sql: string, params?: SqlValue[]): Promise<void> {
    await this.enqueue(() => this.executeBatch([params ? { sql, params } : { sql }]));
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(() => this.executeBatch(splitStatements(sql).map((statement) => ({
      sql: statement,
    }))));
  }

  async batch(statements: SqlStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.enqueue(() => this.executeBatch(statements));
  }

  private async executeBatch(statements: SqlStatement[]): Promise<void> {
    const nativeStatements = statements.flatMap((statement) => {
      if (statement.params) {
        return [{
          query: convertParams(statement.sql),
          values: statement.params.map(serializeValue),
        }];
      }
      return splitStatements(statement.sql).map((query) => ({
        query: convertParams(query),
        values: [],
      }));
    });
    if (nativeStatements.length === 0) return;

    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('execute_sql_batch', {
      db: NIGHTJAR_DB,
      statements: nativeStatements,
    }).catch((error: unknown) => { window.dispatchEvent(new Event('nightjar:save-error')); throw error; });
  }

  async query<T>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return this.enqueue(async () => {
      const converted = convertParams(sql);
      if (isReadQuery(sql)) {
        const { invoke } = await import('@tauri-apps/api/core');
        return invoke<T[]>('execute_sql_query', {
          db: NIGHTJAR_DB,
          query: converted,
          values: (params ?? []).map(serializeValue),
        });
      }
      await this.executeBatch([params ? { sql, params } : { sql }]);
      return [];
    });
  }

  async queryOne<T>(sql: string, params?: SqlValue[]): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async transaction(fn: (transaction: DatabaseTransaction) => Promise<void>): Promise<void> {
    await this.enqueue(async () => {
      const statements: SqlStatement[] = [];
      let hasWrites = false;
      const transaction: DatabaseTransaction = {
        run: async (sql, params) => {
          statements.push(params ? { sql, params } : { sql });
          hasWrites = true;
        },
        exec: async (sql) => {
          statements.push(...splitStatements(sql).map((statement) => ({ sql: statement })));
          hasWrites = true;
        },
        batch: async (batch) => {
          statements.push(...batch);
          hasWrites ||= batch.length > 0;
        },
        query: async <T>(sql: string, params?: SqlValue[]): Promise<T[]> => {
          if (hasWrites) {
            throw new Error('Tauri transactions must perform reads before queued writes');
          }
          const converted = convertParams(sql);
          if (isReadQuery(sql)) {
            const { invoke } = await import('@tauri-apps/api/core');
            return invoke<T[]>('execute_sql_query', {
              db: NIGHTJAR_DB,
              query: converted,
              values: (params ?? []).map(serializeValue),
            });
          }
          statements.push(params ? { sql, params } : { sql });
          hasWrites = true;
          return [];
        },
        queryOne: async <T>(sql: string, params?: SqlValue[]): Promise<T | undefined> => {
          const rows = await transaction.query<T>(sql, params);
          return rows[0];
        },
      };

      await fn(transaction);
      await this.executeBatch(statements);
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_nightjar_db');
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
