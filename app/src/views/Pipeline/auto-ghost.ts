import type { Database } from '@/db/database';

const GHOST_THRESHOLD_DAYS = 45;

export async function runAutoGhost(db: Database): Promise<number> {
  const thresholdDate = new Date(
    Date.now() - GHOST_THRESHOLD_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const stale = await db.query<{ posting_id: string }>(
    `SELECT posting_id FROM applications
     WHERE status = 'applied' AND updated_at < ?`,
    [thresholdDate],
  );

  if (stale.length === 0) return 0;

  const now = new Date().toISOString();
  await db.transaction(async () => {
    for (const row of stale) {
      await db.run(
        `UPDATE applications SET status = 'ghosted', updated_at = ? WHERE posting_id = ?`,
        [now, row.posting_id],
      );
    }
  });

  return stale.length;
}
