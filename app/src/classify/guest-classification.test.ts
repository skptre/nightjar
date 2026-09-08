import { afterEach, beforeEach, expect, it } from 'vitest';
import { NightjarDB } from '@/db/database';
import { recomputeGuestCategories } from './guest-classification';
let db: NightjarDB;
beforeEach(async () => { db = await NightjarDB.createInMemory(); });
afterEach(async () => { await db.close(); });
it('makes role and field filters usable without requiring a personal profile', async () => {
  await db.run('INSERT INTO postings_cache (id,data,synced_at) VALUES (?,?,?)', ['job', JSON.stringify({
    title: 'Avionics Software Engineer Intern', company: 'Example', posted_at: null,
  }), '2026-09-01']);
  expect(await recomputeGuestCategories(db)).toBe(1);
  expect(await recomputeGuestCategories(db)).toBe(0);
  const row = await db.queryOne<{ category: string; role_classification: string; eligibility: null; score: null }>('SELECT category,role_classification,eligibility,score FROM postings_cache');
  expect(row?.category).toBe('swe');
  expect(JSON.parse(row!.role_classification).domain_tags).toContain('aerospace');
  expect(row?.eligibility).toBeNull(); expect(row?.score).toBeNull();
});
