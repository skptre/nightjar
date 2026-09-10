import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@/lib/platform', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { TauriDatabase } from './tauri-database';

describe('TauriDatabase batching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke
      .mockResolvedValueOnce([{ name: 'schema_version' }])
      .mockResolvedValueOnce([{ version: 8 }])
      .mockResolvedValue(undefined);
  });

  it('sends transaction writes through one native SQLite batch', async () => {
    const db = await TauriDatabase.create();
    mocks.invoke.mockClear();

    await db.transaction(async (transaction) => {
      await transaction.run(
        'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
        ['one', '{}', '2026-09-05T00:00:00Z'],
      );
      await transaction.run(
        'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
        ['two', '{}', '2026-09-05T00:00:00Z'],
      );
    });

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('execute_sql_batch', {
      db: 'sqlite:nightjar.db',
      statements: [
        {
          query: 'INSERT INTO postings_cache (id, data, synced_at) VALUES ($1, $2, $3)',
          values: ['one', '{}', '2026-09-05T00:00:00Z'],
        },
        {
          query: 'INSERT INTO postings_cache (id, data, synced_at) VALUES ($1, $2, $3)',
          values: ['two', '{}', '2026-09-05T00:00:00Z'],
        },
      ],
    });
  });

  it('keeps concurrent writes outside an active transaction batch', async () => {
    const db = await TauriDatabase.create();
    mocks.invoke.mockClear();
    let releaseTransaction = (): void => {};
    const holdTransaction = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const transactionPromise = db.transaction(async (transaction) => {
      await transaction.run(
        'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
        ['inside', '{}', '2026-09-05T00:00:00Z'],
      );
      await holdTransaction;
    });
    await Promise.resolve();

    const outsideWrite = db.run(
      'INSERT INTO postings_cache (id, data, synced_at) VALUES (?, ?, ?)',
      ['outside', '{}', '2026-09-05T00:00:00Z'],
    );
    expect(mocks.invoke).not.toHaveBeenCalled();

    releaseTransaction();
    await transactionPromise;
    await outsideWrite;

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'execute_sql_batch', {
      db: 'sqlite:nightjar.db',
      statements: [{
        query: 'INSERT INTO postings_cache (id, data, synced_at) VALUES ($1, $2, $3)',
        values: ['inside', '{}', '2026-09-05T00:00:00Z'],
      }],
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'execute_sql_batch', {
      db: 'sqlite:nightjar.db',
      statements: [{
        query: 'INSERT INTO postings_cache (id, data, synced_at) VALUES ($1, $2, $3)',
        values: ['outside', '{}', '2026-09-05T00:00:00Z'],
      }],
    });
  });
});

it('repairs partial migrations through the native batch interface without erasing data', async () => {
  const { NightjarDB } = await import('./database');
  const backing = await NightjarDB.createInMemory();
  try {
    await backing.run('UPDATE schema_version SET version = 6');
    await backing.exec('ALTER TABLE postings_cache DROP COLUMN classification_version');
    await backing.run("INSERT INTO postings_cache(id,data,synced_at,role_classification) VALUES ('saved','{}','today','keep')");
    mocks.invoke.mockReset().mockImplementation(async (command: string, args: {
      query?: string; values?: (string | number | null)[];
      statements?: { query: string; values: (string | number | null)[] }[];
    }) => {
      if (command === 'execute_sql_query') {
        return backing.query(args.query!.replace(/\$\d+/g, '?'), args.values);
      }
      if (command === 'execute_sql_batch') {
        return backing.transaction(async tx => {
          for (const statement of args.statements!) {
            await tx.run(statement.query.replace(/\$\d+/g, '?'), statement.values);
          }
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    await TauriDatabase.create();
    expect(await backing.queryOne('SELECT version FROM schema_version')).toEqual({ version: 8 });
    expect(await backing.queryOne('SELECT role_classification,classification_version FROM postings_cache'))
      .toEqual({ role_classification: 'keep', classification_version: null });
  } finally { await backing.close(); }
});
