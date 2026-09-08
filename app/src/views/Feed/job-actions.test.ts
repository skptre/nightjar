import { afterEach, beforeEach, expect, it } from 'vitest';
import { NightjarDB } from '@/db/database';
import { saveJob, markJobApplied } from './job-actions';
let db: NightjarDB;
beforeEach(async () => { db = await NightjarDB.createInMemory(); });
afterEach(async () => { await db.close(); });
it('saving again never overwrites interview status, notes or dates', async () => {
  await db.run(`INSERT INTO applications (posting_id,status,notes,applied_at,created_at,updated_at)
    VALUES ('job','phone','Keep this','2026-09-01','2026-08-30','2026-09-02')`);
  await saveJob(db, 'job');
  await markJobApplied(db, 'job');
  expect(await db.queryOne('SELECT status, notes, applied_at FROM applications')).toEqual({
    status: 'phone', notes: 'Keep this', applied_at: '2026-09-01',
  });
});
it('saving and marking applied are separate, durable actions', async () => {
  await saveJob(db, 'job');
  expect((await db.queryOne<{ status: string }>('SELECT status FROM applications'))?.status).toBe('saved');
  await markJobApplied(db, 'job');
  expect((await db.queryOne<{ status: string }>('SELECT status FROM applications'))?.status).toBe('applied');
});
