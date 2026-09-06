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
