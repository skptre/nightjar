import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { runAutoGhost } from './auto-ghost';

function makePostingData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    company: 'Ramp',
    company_slug: 'ramp',
    title: 'Software Engineering Intern',
    location: 'New York, NY',
    locations: ['New York, NY'],
    url: 'https://boards.greenhouse.io/ramp/jobs/12345',
    source: 'greenhouse',
    source_job_id: '12345',
    ats: 'greenhouse',
    posted_at: '2026-08-10T00:00:00Z',
    first_seen_at: '2026-08-10T12:00:00Z',
    last_seen_at: '2026-08-13T12:00:00Z',
    closed_at: null,
    ...overrides,
  });
}

async function insertPosting(
  db: NightjarDB,
  id: string,
  overrides: {
    data?: Record<string, unknown>;
    score?: number | null;
    category?: string | null;
    term?: string | null;
    eligibility?: string | null;
  } = {},
): Promise<void> {
  const dataOverrides = overrides.data ?? {};
  await db.run(
    `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, category, term, eligibility, score, score_breakdown, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      makePostingData({ company_slug: id, ...dataOverrides }),
      '2026-08-10T12:00:00Z',
      null,
      overrides.category ?? 'swe',
      overrides.term ?? 'summer_2027',
      overrides.eligibility ?? JSON.stringify({ verdict: 'unclear', reasons: [], flags: [] }),
      overrides.score !== undefined ? overrides.score : 75,
      JSON.stringify({ tier: 15, freshness: 30, category: 20, eligibility: 15 }),
      '2026-08-13T12:00:00Z',
    ],
  );
}

async function createApplication(
  db: NightjarDB,
  postingId: string,
  status: string,
  overrides: {
    applied_at?: string | null;
    notes?: string | null;
    created_at?: string;
    updated_at?: string;
  } = {},
): Promise<void> {
  const now = '2026-08-13T14:00:00Z';
  await db.run(
    `INSERT INTO applications (posting_id, status, applied_at, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      postingId,
      status,
      overrides.applied_at ?? null,
      overrides.notes ?? null,
      overrides.created_at ?? now,
      overrides.updated_at ?? now,
    ],
  );
}

interface PipelineQueryRow {
  id: string;
  status: string;
  applied_at: string | null;
  notes: string | null;
  app_updated_at: string;
}

async function queryPipeline(db: NightjarDB): Promise<PipelineQueryRow[]> {
  return await db.query<PipelineQueryRow>(
    `SELECT p.id, a.status, a.applied_at, a.notes, a.updated_at as app_updated_at
     FROM postings_cache p
     INNER JOIN applications a ON p.id = a.posting_id
     WHERE a.status != 'new'
     ORDER BY a.updated_at DESC`,
  );
}

async function queryByStatus(db: NightjarDB, status: string): Promise<PipelineQueryRow[]> {
  return await db.query<PipelineQueryRow>(
    `SELECT p.id, a.status, a.applied_at, a.notes, a.updated_at as app_updated_at
     FROM postings_cache p
     INNER JOIN applications a ON p.id = a.posting_id
     WHERE a.status = ?
     ORDER BY a.updated_at DESC`,
    [status],
  );
}

describe('Pipeline View Data Layer', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(async () => {
    await db.close();
  });

  describe('status persistence', () => {
    it('saved posting appears in pipeline query', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'saved');

      const rows = await queryPipeline(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('saved');
    });

    it('applied posting persists with applied_at', async () => {
      await insertPosting(db, 'p1');
      const appliedAt = '2026-08-13T15:00:00Z';
      await createApplication(db, 'p1', 'applied', { applied_at: appliedAt });

      const rows = await queryPipeline(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('applied');
      expect(rows[0]?.applied_at).toBe(appliedAt);
    });

    it('status persists after re-query (simulating refresh)', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'applied', { applied_at: '2026-08-13T15:00:00Z' });

      const first = await queryPipeline(db);
      expect(first[0]?.status).toBe('applied');

      const second = await queryPipeline(db);
      expect(second[0]?.status).toBe('applied');
    });

    it('new status is excluded from pipeline', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'new');

      const rows = await queryPipeline(db);
      expect(rows).toHaveLength(0);
    });

    it('all valid statuses appear in pipeline', async () => {
      const statuses = ['saved', 'applied', 'oa', 'phone', 'onsite', 'offer', 'rejected', 'ghosted', 'skipped'];
      for (const status of statuses) {
        await insertPosting(db, status);
        await createApplication(db, status, status, {
          applied_at: status === 'applied' ? '2026-08-13T15:00:00Z' : null,
        });
      }

      const rows = await queryPipeline(db);
      expect(rows).toHaveLength(statuses.length);

      const foundStatuses = new Set(rows.map((r) => r.status));
      for (const status of statuses) {
        expect(foundStatuses.has(status)).toBe(true);
      }
    });
  });

  describe('status change (drag simulation)', () => {
    it('changing from applied to phone updates status and updated_at', async () => {
      await insertPosting(db, 'p1');
      const oldUpdatedAt = '2026-07-01T14:00:00Z';
      await createApplication(db, 'p1', 'applied', {
        applied_at: '2026-07-01T14:00:00Z',
        updated_at: oldUpdatedAt,
      });

      const now = '2026-08-13T16:00:00Z';
      await db.run(
        `UPDATE applications SET status = ?, updated_at = ? WHERE posting_id = ?`,
        ['phone', now, 'p1'],
      );

      const rows = await queryPipeline(db);
      expect(rows[0]?.status).toBe('phone');
      expect(rows[0]?.app_updated_at).toBe(now);
    });

    it('changing from saved to applied sets applied_at', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'saved');

      const now = '2026-08-13T16:00:00Z';
      await db.run(
        `UPDATE applications SET status = 'applied', applied_at = ?, updated_at = ? WHERE posting_id = ?`,
        [now, now, 'p1'],
      );

      const rows = await queryPipeline(db);
      expect(rows[0]?.status).toBe('applied');
      expect(rows[0]?.applied_at).toBe(now);
    });

    it('changing from phone to onsite preserves applied_at', async () => {
      await insertPosting(db, 'p1');
      const appliedAt = '2026-08-01T14:00:00Z';
      await createApplication(db, 'p1', 'phone', { applied_at: appliedAt });

      const now = '2026-08-13T16:00:00Z';
      await db.run(
        `UPDATE applications SET status = 'onsite', updated_at = ? WHERE posting_id = ?`,
        [now, 'p1'],
      );

      const rows = await queryPipeline(db);
      expect(rows[0]?.status).toBe('onsite');
      expect(rows[0]?.applied_at).toBe(appliedAt);
    });

    it('changing from applied to rejected works', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'applied', { applied_at: '2026-08-01T14:00:00Z' });

      await db.run(
        `UPDATE applications SET status = 'rejected', updated_at = ? WHERE posting_id = ?`,
        ['2026-08-13T16:00:00Z', 'p1'],
      );

      const applied = await queryByStatus(db, 'applied');
      const rejected = await queryByStatus(db, 'rejected');
      expect(applied).toHaveLength(0);
      expect(rejected).toHaveLength(1);
    });

    it('moving between non-applied columns does not change applied_at', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'oa', { applied_at: null });

      await db.run(
        `UPDATE applications SET status = 'phone', updated_at = ? WHERE posting_id = ?`,
        ['2026-08-13T16:00:00Z', 'p1'],
      );

      const rows = await queryPipeline(db);
      expect(rows[0]?.status).toBe('phone');
      expect(rows[0]?.applied_at).toBeNull();
    });
  });

  describe('column counts', () => {
    it('counts match actual number of postings in each status', async () => {
      await insertPosting(db, 's1');
      await insertPosting(db, 's2');
      await insertPosting(db, 'a1');
      await insertPosting(db, 'o1');
      await insertPosting(db, 'o2');
      await insertPosting(db, 'o3');

      await createApplication(db, 's1', 'saved');
      await createApplication(db, 's2', 'saved');
      await createApplication(db, 'a1', 'applied', { applied_at: '2026-08-13T15:00:00Z' });
      await createApplication(db, 'o1', 'offer');
      await createApplication(db, 'o2', 'offer');
      await createApplication(db, 'o3', 'offer');

      const saved = await queryByStatus(db, 'saved');
      const applied = await queryByStatus(db, 'applied');
      const offer = await queryByStatus(db, 'offer');
      const phone = await queryByStatus(db, 'phone');

      expect(saved).toHaveLength(2);
      expect(applied).toHaveLength(1);
      expect(offer).toHaveLength(3);
      expect(phone).toHaveLength(0);
    });
  });

  describe('notes persistence', () => {
    it('saving notes persists to database', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'saved');

      await db.run(
        `UPDATE applications SET notes = ?, updated_at = ? WHERE posting_id = ?`,
        ['Warm intro via Sarah', '2026-08-13T16:00:00Z', 'p1'],
      );

      const rows = await queryPipeline(db);
      expect(rows[0]?.notes).toBe('Warm intro via Sarah');
    });

    it('clearing notes sets to null', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'saved', { notes: 'Some notes' });

      await db.run(
        `UPDATE applications SET notes = NULL, updated_at = ? WHERE posting_id = ?`,
        ['2026-08-13T16:00:00Z', 'p1'],
      );

      const rows = await queryPipeline(db);
      expect(rows[0]?.notes).toBeNull();
    });
  });

  describe('skipped postings', () => {
    it('skipped postings are in pipeline query', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'skipped');

      const rows = await queryPipeline(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('skipped');
    });

    it('skipped can be restored to saved', async () => {
      await insertPosting(db, 'p1');
      await createApplication(db, 'p1', 'skipped');

      await db.run(
        `UPDATE applications SET status = 'saved', updated_at = ? WHERE posting_id = ?`,
        ['2026-08-13T16:00:00Z', 'p1'],
      );

      const skipped = await queryByStatus(db, 'skipped');
      const saved = await queryByStatus(db, 'saved');
      expect(skipped).toHaveLength(0);
      expect(saved).toHaveLength(1);
    });
  });

  describe('ordering', () => {
    it('pipeline cards ordered by updated_at descending', async () => {
      await insertPosting(db, 'old');
      await insertPosting(db, 'mid');
      await insertPosting(db, 'new');

      await createApplication(db, 'old', 'saved', { updated_at: '2026-08-01T12:00:00Z' });
      await createApplication(db, 'mid', 'saved', { updated_at: '2026-08-07T12:00:00Z' });
      await createApplication(db, 'new', 'saved', { updated_at: '2026-08-13T12:00:00Z' });

      const rows = await queryPipeline(db);
      expect(rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    });
  });
});

describe('Auto-Ghost', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
  });

  it('ghosts applied posting older than 45 days', async () => {
    await insertPosting(db, 'p1');
    const fortySevenDaysAgo = new Date(Date.now() - 47 * 24 * 60 * 60 * 1000).toISOString();
    await createApplication(db, 'p1', 'applied', {
      applied_at: fortySevenDaysAgo,
      updated_at: fortySevenDaysAgo,
    });

    const count = await runAutoGhost(db);
    expect(count).toBe(1);

    const app = await db.queryOne<{ status: string }>(
      'SELECT status FROM applications WHERE posting_id = ?',
      ['p1'],
    );
    expect(app?.status).toBe('ghosted');
  });

  it('does NOT ghost posting at exactly 44 days', async () => {
    await insertPosting(db, 'p1');
    const fortyFourDaysAgo = new Date(Date.now() - 44 * 24 * 60 * 60 * 1000).toISOString();
    await createApplication(db, 'p1', 'applied', {
      applied_at: fortyFourDaysAgo,
      updated_at: fortyFourDaysAgo,
    });

    const count = await runAutoGhost(db);
    expect(count).toBe(0);

    const app = await db.queryOne<{ status: string }>(
      'SELECT status FROM applications WHERE posting_id = ?',
      ['p1'],
    );
    expect(app?.status).toBe('applied');
  });

  it('does NOT ghost posting at exactly 45 days (boundary — strict less-than)', async () => {
    const frozenNow = new Date('2026-08-14T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);

    await insertPosting(db, 'p1');
    const exactlyFortyFiveDaysAgo = new Date(frozenNow - 45 * 24 * 60 * 60 * 1000).toISOString();
    await createApplication(db, 'p1', 'applied', {
      applied_at: exactlyFortyFiveDaysAgo,
      updated_at: exactlyFortyFiveDaysAgo,
    });

    const count = await runAutoGhost(db);

    const app = await db.queryOne<{ status: string }>(
      'SELECT status FROM applications WHERE posting_id = ?',
      ['p1'],
    );
    expect(app?.status).toBe('applied');
    expect(count).toBe(0);

    vi.useRealTimers();
  });

  it('ghosts at 46 days', async () => {
    await insertPosting(db, 'p1');
    const fortySixDaysAgo = new Date(Date.now() - 46 * 24 * 60 * 60 * 1000).toISOString();
    await createApplication(db, 'p1', 'applied', {
      applied_at: fortySixDaysAgo,
      updated_at: fortySixDaysAgo,
    });

    const count = await runAutoGhost(db);
    expect(count).toBe(1);

    const app = await db.queryOne<{ status: string }>(
      'SELECT status FROM applications WHERE posting_id = ?',
      ['p1'],
    );
    expect(app?.status).toBe('ghosted');
  });

  it('only ghosts "applied" status, not "saved" or "phone"', async () => {
    await insertPosting(db, 'saved1');
    await insertPosting(db, 'phone1');
    await insertPosting(db, 'applied1');

    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await createApplication(db, 'saved1', 'saved', { updated_at: longAgo });
    await createApplication(db, 'phone1', 'phone', { updated_at: longAgo });
    await createApplication(db, 'applied1', 'applied', {
      applied_at: longAgo,
      updated_at: longAgo,
    });

    const count = await runAutoGhost(db);
    expect(count).toBe(1);

    expect(
      (await db.queryOne<{ status: string }>('SELECT status FROM applications WHERE posting_id = ?', ['saved1']))?.status,
    ).toBe('saved');
    expect(
      (await db.queryOne<{ status: string }>('SELECT status FROM applications WHERE posting_id = ?', ['phone1']))?.status,
    ).toBe('phone');
    expect(
      (await db.queryOne<{ status: string }>('SELECT status FROM applications WHERE posting_id = ?', ['applied1']))?.status,
    ).toBe('ghosted');
  });

  it('ghosts multiple stale postings in one call', async () => {
    await insertPosting(db, 'p1');
    await insertPosting(db, 'p2');
    await insertPosting(db, 'p3');

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await createApplication(db, 'p1', 'applied', {
      applied_at: sixtyDaysAgo,
      updated_at: sixtyDaysAgo,
    });
    await createApplication(db, 'p2', 'applied', {
      applied_at: sixtyDaysAgo,
      updated_at: sixtyDaysAgo,
    });
    await createApplication(db, 'p3', 'applied', {
      applied_at: thirtyDaysAgo,
      updated_at: thirtyDaysAgo,
    });

    const count = await runAutoGhost(db);
    expect(count).toBe(2);

    expect(
      (await db.queryOne<{ status: string }>('SELECT status FROM applications WHERE posting_id = ?', ['p1']))?.status,
    ).toBe('ghosted');
    expect(
      (await db.queryOne<{ status: string }>('SELECT status FROM applications WHERE posting_id = ?', ['p2']))?.status,
    ).toBe('ghosted');
    expect(
      (await db.queryOne<{ status: string }>('SELECT status FROM applications WHERE posting_id = ?', ['p3']))?.status,
    ).toBe('applied');
  });

  it('returns 0 when no postings need ghosting', async () => {
    await insertPosting(db, 'p1');
    await createApplication(db, 'p1', 'applied', {
      applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const count = await runAutoGhost(db);
    expect(count).toBe(0);
  });

  it('returns 0 when applications table is empty', async () => {
    const count = await runAutoGhost(db);
    expect(count).toBe(0);
  });

  it('sets updated_at on ghosted postings', async () => {
    await insertPosting(db, 'p1');
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await createApplication(db, 'p1', 'applied', {
      applied_at: sixtyDaysAgo,
      updated_at: sixtyDaysAgo,
    });

    const before = Date.now();
    await runAutoGhost(db);
    const after = Date.now();

    const app = await db.queryOne<{ updated_at: string }>(
      'SELECT updated_at FROM applications WHERE posting_id = ?',
      ['p1'],
    );
    expect(app).toBeDefined();
    const updatedMs = new Date(app!.updated_at).getTime();
    expect(updatedMs).toBeGreaterThanOrEqual(before);
    expect(updatedMs).toBeLessThanOrEqual(after + 1000);
  });

  it('does not ghost already-ghosted postings', async () => {
    await insertPosting(db, 'p1');
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await createApplication(db, 'p1', 'ghosted', { updated_at: sixtyDaysAgo });

    const count = await runAutoGhost(db);
    expect(count).toBe(0);
  });
});
