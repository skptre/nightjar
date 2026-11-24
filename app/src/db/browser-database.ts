import type { Database, DatabaseTransaction, SqlStatement, SqlValue } from './types';

// SQLite parsing, queries and IndexedDB snapshots run off the UI thread. The
// transaction queue preserves atomicity while callbacks remain in the caller.
export class BrowserDatabase implements Database {
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: Error | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private readonly worker: Worker) {
    worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string; event?: string }>) => {
      if (data.event === 'save-error') { window.dispatchEvent(new Event('nightjar:save-error')); return; }
      const waiting = this.pending.get(data.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      if (data.error) waiting.reject(new Error(data.error)); else waiting.resolve(data.result);
    };
    worker.onerror = () => this.fail(new Error('Could not run the local database worker. Reopen Nightjar to retry.'));
    worker.onmessageerror = () => this.fail(new Error('Could not read a local database response. Reopen Nightjar to retry.'));
  }

  static async create(): Promise<BrowserDatabase> {
    const instance = new BrowserDatabase(new Worker(new URL('./browser-worker.ts', import.meta.url), { type: 'module' }));
    try { await instance.request('open'); return instance; }
    catch (error) { instance.worker.terminate(); throw error; }
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }

  private request<T = void>(action: string, data: Record<string, unknown> = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { this.worker.postMessage({ id, action, ...data }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  run(sql: string, params?: SqlValue[]): Promise<void> { return this.enqueue(() => this.request('run', { sql, params })); }
  exec(sql: string): Promise<void> { return this.enqueue(() => this.request('exec', { sql })); }
  batch(statements: SqlStatement[]): Promise<void> {
    return statements.length ? this.enqueue(() => this.request('batch', { statements })) : Promise.resolve();
  }
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]> { return this.enqueue(() => this.request('query', { sql, params })); }
  async queryOne<T>(sql: string, params?: SqlValue[]): Promise<T | undefined> { return (await this.query<T>(sql, params))[0]; }

  transaction(fn: (transaction: DatabaseTransaction) => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      await this.request('begin');
      const tx: DatabaseTransaction = {
        run: (sql, params) => this.request('run', { sql, params }),
        exec: sql => this.request('exec', { sql }),
        batch: statements => this.request('batch', { statements }),
        query: <T>(sql: string, params?: SqlValue[]) => this.request<T[]>('query', { sql, params }),
        queryOne: async <T>(sql: string, params?: SqlValue[]) => (await this.request<T[]>('query', { sql, params }))[0],
      };
      try { await fn(tx); }
      catch (error) { await this.request('rollback'); throw error; }
      await this.request('commit');
    });
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      try { await this.request('close'); }
      finally { this.worker.terminate(); this.fail(new Error('Database is closed')); }
    });
  }
}
