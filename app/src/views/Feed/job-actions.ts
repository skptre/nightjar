import type { Database } from '@/db/database';
import { transitionApplicationStatus } from '@/outcomes/outcome-service';
export async function saveJob(db: Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.run(`INSERT INTO applications (posting_id,status,created_at,updated_at)
    VALUES (?,'saved',?,?) ON CONFLICT(posting_id) DO UPDATE SET
    status = CASE WHEN status IN ('new','skipped') THEN 'saved' ELSE status END`, [id, now, now]);
}
export async function markJobApplied(db: Database, id: string): Promise<void> {
  await saveJob(db, id);
  const row = await db.queryOne<{ status: string }>('SELECT status FROM applications WHERE posting_id = ?', [id]);
  if (row?.status === 'saved') await transitionApplicationStatus(db, id, 'applied');
}
