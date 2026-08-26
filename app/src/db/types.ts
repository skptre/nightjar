export type SqlValue = string | number | Uint8Array | null;

export interface Database {
  run(sql: string, params?: SqlValue[]): Promise<void>;
  exec(sql: string): Promise<void>;
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  transaction(fn: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
