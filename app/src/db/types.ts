export type SqlValue = string | number | Uint8Array | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface DatabaseTransaction {
  run(sql: string, params?: SqlValue[]): Promise<void>;
  exec(sql: string): Promise<void>;
  batch(statements: SqlStatement[]): Promise<void>;
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
}

export interface Database extends DatabaseTransaction {
  transaction(fn: (transaction: DatabaseTransaction) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
