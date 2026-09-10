import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase, NightjarDB } from './database';
import { getSchemaVersion, runMigrations } from './migrations';
vi.mock('@/lib/platform', () => ({ isTauri: () => false }));
afterEach(() => vi.restoreAllMocks());

it.each([true, false])('recovers an interrupted classification migration, missing second column: %s', async missing => {
  const db = await NightjarDB.createInMemory();
  try {
    await db.run("INSERT INTO postings_cache (id,data,synced_at,role_classification) VALUES ('saved','{}','today','preserve')");
    await db.run("INSERT INTO applications (posting_id,status,created_at,updated_at) VALUES ('saved','applied','today','today')");
    await db.run('UPDATE schema_version SET version = 6');
    if (missing) await db.exec('ALTER TABLE postings_cache DROP COLUMN classification_version');
    await runMigrations(db);
    await runMigrations(db);
    expect(await getSchemaVersion(db)).toBe(8);
    expect(await db.queryOne('SELECT role_classification, classification_version FROM postings_cache')).toEqual({ role_classification: 'preserve', classification_version: null });
    expect(await db.queryOne('SELECT status FROM applications')).toEqual({ status: 'applied' });
  } finally { await db.close(); }
});

it('shares concurrent startup so React remounts cannot race migrations', async () => {
  const db = await NightjarDB.createInMemory();
  const open = vi.spyOn(NightjarDB, 'create').mockResolvedValue(db);
  try {
    const [first, second] = await Promise.all([createDatabase(), createDatabase()]);
    expect(first).toBe(second);
    expect(open).toHaveBeenCalledTimes(1);
  } finally { await db.close(); }
});
