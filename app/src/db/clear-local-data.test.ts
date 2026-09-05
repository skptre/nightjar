import { beforeEach, describe, expect, it } from 'vitest';
import { NightjarDB } from './database';
import { clearAllLocalData } from './clear-local-data';

describe('clearAllLocalData', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('clears both database records and Nightjar-owned browser storage', async () => {
    await db.run(
      `INSERT INTO postings_cache (id, data, synced_at) VALUES ('p1', '{}', '2026-09-04T00:00:00Z')`,
    );
    await db.run(
      `INSERT INTO applications (posting_id, status, created_at, updated_at)
       VALUES ('p1', 'saved', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`,
    );
    localStorage.setItem('nightjar_profile', '{}');
    sessionStorage.setItem('gmail_code_verifier', 'secret');
    localStorage.setItem('unrelated_app_key', 'keep');

    await clearAllLocalData(db);

    expect(await db.query<{ id: string }>('SELECT id FROM postings_cache')).toEqual([]);
    expect(await db.query<{ posting_id: string }>('SELECT posting_id FROM applications')).toEqual([]);
    expect(localStorage.getItem('nightjar_profile')).toBeNull();
    expect(sessionStorage.getItem('gmail_code_verifier')).toBeNull();
    expect(localStorage.getItem('unrelated_app_key')).toBe('keep');
  });
});
