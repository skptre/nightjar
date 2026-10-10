import { afterEach, beforeEach, expect, it } from 'vitest';
import { NightjarDB } from '@/db/database';
import { annotateLatestOutcome, restoreApplicationStatus, snapshotApplicationStatus, transitionApplicationStatus } from './outcome-service';

let db: NightjarDB;
beforeEach(async () => {
  db = await NightjarDB.createInMemory();
  await db.run("INSERT INTO postings_cache (id,data,synced_at) VALUES ('job','{}','2026-09-01')");
  await db.run("INSERT INTO applications (posting_id,status,created_at,updated_at) VALUES ('job','applied','2026-09-01','2026-09-01')");
});
afterEach(async () => { await db.close(); });

it('undoes a stage move, including the history it wrote', async () => {
  const snapshot = await snapshotApplicationStatus(db, 'job');
  await transitionApplicationStatus(db, 'job', 'phone');
  expect((await db.query('SELECT * FROM application_outcome_events')).length).toBe(1);
  await restoreApplicationStatus(db, snapshot);
  expect((await db.queryOne<{ status: string; outcome: string | null }>('SELECT status, outcome FROM applications'))).toMatchObject({ status: 'applied', outcome: null });
  expect((await db.query('SELECT * FROM application_outcome_events')).length).toBe(0);
});

it('adds notes and rounds to the outcome that was just recorded', async () => {
  await transitionApplicationStatus(db, 'job', 'onsite');
  await annotateLatestOutcome(db, 'job', { notes: '  Went well.  ', interviewRounds: 3 });
  expect(await db.queryOne('SELECT notes, interview_rounds FROM application_outcome_events')).toMatchObject({ notes: 'Went well.', interview_rounds: 3 });
  expect(await db.queryOne('SELECT outcome_notes, interview_rounds FROM applications')).toMatchObject({ outcome_notes: 'Went well.', interview_rounds: 3 });
});
