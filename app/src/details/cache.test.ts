import { afterEach, beforeEach, expect, it } from 'vitest';
import { NightjarDB } from '@/db/database';
import { refreshJobDetails, getJobDetails } from './cache';
import type { Profile } from '@/profile/types';

let db: NightjarDB;
const profile: Profile = { graduation: '2028-05', grad_window: ['2027-11','2028-06'],
  work_auth: 'f1_opt_cpt', requires_sponsorship: true, current_class_year: 'unknown',
  target_categories: [], locations: ['US'], excluded_companies: [], tiers: {}, contacts: {} };
beforeEach(async () => { db = await NightjarDB.createInMemory(); });
afterEach(async () => { await db.close(); });

it('recomputes on content, profile, and acquisition changes without altering saved applications', async () => {
  const data = { id: '1', title: 'Summer Intern', description_status: 'available' };
  await db.run("INSERT INTO postings_cache(id,data,description,synced_at) VALUES(?,?,?,'now')",
    ['1', JSON.stringify(data), 'US citizens only.']);
  await db.run("INSERT INTO applications(posting_id,status,notes,created_at,updated_at) VALUES('1','applied','Keep my notes','now','now')");
  expect(await refreshJobDetails(db, profile)).toBe(1);
  expect((await getJobDetails(db, '1'))?.assessment?.exclude).toBe(true);
  expect(await refreshJobDetails(db, profile)).toBe(0);
  expect(await refreshJobDetails(db, { ...profile, work_auth: 'us_citizen' })).toBe(1);
  expect((await getJobDetails(db, '1'))?.assessment?.exclude).toBe(false);
  await db.run('UPDATE postings_cache SET data = ? WHERE id = ?',
    [JSON.stringify({ ...data, description_status: 'stale' }), '1']);
  await refreshJobDetails(db, profile);
  expect((await getJobDetails(db, '1'))?.assessment?.exclude).toBe(false);
  await db.run('UPDATE postings_cache SET description = ? WHERE id = ?', ['No visa sponsorship.', '1']);
  expect(await refreshJobDetails(db, profile)).toBe(1);
  expect((await getJobDetails(db, '1'))?.details.document).toBe('No visa sponsorship.');
  expect(await db.queryOne('SELECT status, notes FROM applications WHERE posting_id = ?', ['1']))
    .toEqual({ status: 'applied', notes: 'Keep my notes' });
  expect(await db.queryOne('SELECT eligibility, score, classification_version FROM postings_cache WHERE id = ?', ['1']))
    .toEqual({ eligibility: null, score: null, classification_version: null });
});

it('extracts descriptions offline without requiring a private profile', async () => {
  await db.run("INSERT INTO postings_cache(id,data,description,synced_at) VALUES('1','{}',?,'now')",
    ['Responsibilities\n\nBuild avionics software.']);
  await refreshJobDetails(db, null);
  const result = await getJobDetails(db, '1');
  expect(result?.details.sections.responsibilities[0]?.text).toBe('Build avionics software.');
  expect(result?.assessment).toBeNull();
});
