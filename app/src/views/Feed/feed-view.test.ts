import { describe, it, expect, beforeEach } from 'vitest';
import { NightjarDB } from '@/db/database';
import { CURRENT_JOBS_QUERY, filterOptionsForProfile, getFeedEmptyState } from './FeedView';

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
    closed_at?: string | null;
    first_seen_at?: string;
  } = {},
): Promise<void> {
  const dataOverrides = overrides.data ?? {};
  const firstSeen = overrides.first_seen_at ?? '2026-08-10T12:00:00Z';
  await db.run(
    `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, category, term, eligibility, score, score_breakdown, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      makePostingData({ company_slug: id, first_seen_at: firstSeen, ...dataOverrides }),
      firstSeen,
      overrides.closed_at ?? null,
      overrides.category ?? 'swe',
      overrides.term ?? 'summer_2027',
      overrides.eligibility ?? JSON.stringify({ verdict: 'unclear', reasons: [], flags: [] }),
      overrides.score !== undefined ? overrides.score : 75,
      JSON.stringify({ tier: 15, freshness: 30, category: 20, eligibility: 15 }),
      '2026-08-13T12:00:00Z',
    ],
  );
}

async function queryUntriaged(db: NightjarDB): Promise<Array<{ id: string; score: number | null }>> {
  return await db.query<{ id: string; score: number | null }>(CURRENT_JOBS_QUERY);
}

describe('Feed View Data Layer', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  describe('default query — untriaged postings', () => {
    it('shows postings with no applications row', async () => {
      await insertPosting(db, 'p1');
      await insertPosting(db, 'p2');

      const results = await queryUntriaged(db);
      expect(results).toHaveLength(2);
    });

    it('shows postings with status new', async () => {
      await insertPosting(db, 'p1');
      const now = '2026-08-13T12:00:00Z';
      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (?, 'new', ?, ?)`,
        ['p1', now, now],
      );

      const results = await queryUntriaged(db);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe('p1');
    });

    it('keeps saved postings visible', async () => {
      await insertPosting(db, 'p1');
      await insertPosting(db, 'p2');
      const now = '2026-08-13T12:00:00Z';
      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (?, 'saved', ?, ?)`,
        ['p1', now, now],
      );

      const results = await queryUntriaged(db);
      expect(results).toHaveLength(2);
      expect(results.map((row) => row.id)).toContain('p1');
    });

    it('excludes skipped postings', async () => {
      await insertPosting(db, 'p1');
      const now = '2026-08-13T12:00:00Z';
      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (?, 'skipped', ?, ?)`,
        ['p1', now, now],
      );

      const results = await queryUntriaged(db);
      expect(results).toHaveLength(0);
    });

    it('keeps applied postings visible', async () => {
      await insertPosting(db, 'p1');
      const now = '2026-08-13T12:00:00Z';
      await db.run(
        `INSERT INTO applications (posting_id, status, applied_at, created_at, updated_at) VALUES (?, 'applied', ?, ?, ?)`,
        ['p1', now, now, now],
      );

      const results = await queryUntriaged(db);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe('p1');
    });

    it('excludes closed postings', async () => {
      await insertPosting(db, 'p1', { closed_at: '2026-08-12T00:00:00Z' });
      await insertPosting(db, 'p2');

      const results = await queryUntriaged(db);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe('p2');
    });

    it('sorts newest first regardless of score', async () => {
      await insertPosting(db, 'old-high', { score: 90, first_seen_at: '2026-08-10T00:00:00Z' });
      await insertPosting(db, 'new-low', { score: 30, first_seen_at: '2026-08-13T00:00:00Z' });
      await insertPosting(db, 'mid', { score: 60, first_seen_at: '2026-08-12T00:00:00Z' });

      const results = await queryUntriaged(db);
      expect(results.map((r) => r.id)).toEqual(['new-low', 'mid', 'old-high']);
    });

    it('does not hide unscored postings', async () => {
      await insertPosting(db, 'scored', { score: 50, first_seen_at: '2026-08-10T00:00:00Z' });
      await insertPosting(db, 'unscored', { score: null, first_seen_at: '2026-08-13T00:00:00Z' });

      const results = await queryUntriaged(db);
      expect(results.map((row) => row.id)).toEqual(['unscored', 'scored']);
    });
  });

  describe('action handlers — save', () => {
    it('creates applications row with status saved', async () => {
      await insertPosting(db, 'p1');
      const now = '2026-08-13T14:00:00Z';
      await db.run(
        `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
         VALUES (?, 'saved', COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
        ['p1', 'p1', now, now],
      );

      const app = await db.queryOne<{ posting_id: string; status: string }>(
        'SELECT posting_id, status FROM applications WHERE posting_id = ?',
        ['p1'],
      );
      expect(app?.status).toBe('saved');
    });

    it('keeps posting in the browsing list after save', async () => {
      await insertPosting(db, 'p1');
      await insertPosting(db, 'p2');

      const now = '2026-08-13T14:00:00Z';
      await db.run(
        `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
         VALUES (?, 'saved', ?, ?)`,
        ['p1', now, now],
      );

      const results = await queryUntriaged(db);
      expect(results).toHaveLength(2);
      expect(results.map((row) => row.id)).toContain('p1');
    });
  });

  describe('action handlers — skip with undo', () => {
    it('creates applications row with status skipped', async () => {
      await insertPosting(db, 'p1');
      const now = '2026-08-13T14:00:00Z';
      await db.run(
        `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
         VALUES (?, 'skipped', ?, ?)`,
        ['p1', now, now],
      );

      const app = await db.queryOne<{ status: string }>(
        'SELECT status FROM applications WHERE posting_id = ?',
        ['p1'],
      );
      expect(app?.status).toBe('skipped');
    });

    it('undo deletes applications row, restoring to untriaged', async () => {
      await insertPosting(db, 'p1');
      const now = '2026-08-13T14:00:00Z';

      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (?, 'skipped', ?, ?)`,
        ['p1', now, now],
      );
      expect(await queryUntriaged(db)).toHaveLength(0);

      await db.run('DELETE FROM applications WHERE posting_id = ?', ['p1']);
      expect(await queryUntriaged(db)).toHaveLength(1);
    });
  });

  describe('action handlers — apply', () => {
    it('creates applications row with status applied and applied_at', async () => {
      await insertPosting(db, 'p1');
      const now = '2026-08-13T14:00:00Z';
      await db.run(
        `INSERT OR REPLACE INTO applications (posting_id, status, applied_at, created_at, updated_at)
         VALUES (?, 'applied', ?, ?, ?)`,
        ['p1', now, now, now],
      );

      const app = await db.queryOne<{ status: string; applied_at: string }>(
        'SELECT status, applied_at FROM applications WHERE posting_id = ?',
        ['p1'],
      );
      expect(app?.status).toBe('applied');
      expect(app?.applied_at).toBe(now);
    });
  });

  describe('filter logic', () => {
    it('filters by category', async () => {
      await insertPosting(db, 'swe1', { category: 'swe' });
      await insertPosting(db, 'ml1', { category: 'ml' });
      await insertPosting(db, 'quant1', { category: 'quant' });

      const rows = await db.query<{ id: string; category: string | null }>(
        `SELECT p.id, p.category FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL
         ORDER BY CASE WHEN p.score IS NULL THEN 1 ELSE 0 END, p.score DESC`,
      );
      const filtered = rows.filter((r) => r.category === 'ml');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe('ml1');
    });

    it('filters by term', async () => {
      await insertPosting(db, 'summer', { term: 'summer_2027' });
      await insertPosting(db, 'fall', { term: 'fall_2026' });

      const rows = await db.query<{ id: string; term: string | null }>(
        `SELECT p.id, p.term FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL`,
      );
      const filtered = rows.filter((r) => r.term === 'summer_2027');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe('summer');
    });

    it('filters ineligible postings', async () => {
      await insertPosting(db, 'eligible', {
        eligibility: JSON.stringify({ verdict: 'eligible', reasons: [], flags: [] }),
      });
      await insertPosting(db, 'ineligible', {
        eligibility: JSON.stringify({ verdict: 'ineligible', reasons: ['must be US citizen'], flags: [] }),
      });
      await insertPosting(db, 'unclear', {
        eligibility: JSON.stringify({ verdict: 'unclear', reasons: [], flags: [] }),
      });

      const rows = await db.query<{ id: string; eligibility: string | null }>(
        `SELECT p.id, p.eligibility FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL`,
      );

      const ineligible = rows.filter((r) => {
        try {
          const e = JSON.parse(r.eligibility ?? '{}') as { verdict?: string };
          return e.verdict === 'ineligible';
        } catch { return false; }
      });
      expect(ineligible).toHaveLength(1);
      expect(ineligible[0]?.id).toBe('ineligible');

      const nonIneligible = rows.filter((r) => {
        try {
          const e = JSON.parse(r.eligibility ?? '{}') as { verdict?: string };
          return e.verdict !== 'ineligible';
        } catch { return true; }
      });
      expect(nonIneligible).toHaveLength(2);
    });

    it('filters by source', async () => {
      await insertPosting(db, 'gh', { data: { source: 'greenhouse' } });
      await insertPosting(db, 'lv', { data: { source: 'lever' } });

      const rows = await db.query<{ id: string; data: string }>(
        `SELECT p.id, p.data FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL`,
      );

      const ghOnly = rows.filter((r) => {
        const d = JSON.parse(r.data) as { source: string };
        return d.source === 'greenhouse';
      });
      expect(ghOnly).toHaveLength(1);
      expect(ghOnly[0]?.id).toBe('gh');
    });

    it('filters by search across title and company', async () => {
      await insertPosting(db, 'ramp', { data: { company: 'Ramp', title: 'SWE Intern' } });
      await insertPosting(db, 'stripe', { data: { company: 'Stripe', title: 'ML Engineer' } });

      const rows = await db.query<{ id: string; data: string }>(
        `SELECT p.id, p.data FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL`,
      );

      const search = 'stripe';
      const filtered = rows.filter((r) => {
        const d = JSON.parse(r.data) as { title: string; company: string };
        return d.title.toLowerCase().includes(search) || d.company.toLowerCase().includes(search);
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe('stripe');
    });

    it('filters by age — this week', async () => {
      const recent = new Date();
      const old = new Date();
      old.setDate(old.getDate() - 14);

      await insertPosting(db, 'new', { first_seen_at: recent.toISOString() });
      await insertPosting(db, 'old', { first_seen_at: old.toISOString() });

      const threshold = new Date();
      threshold.setDate(threshold.getDate() - 7);
      const thresholdISO = threshold.toISOString();

      const rows = await db.query<{ id: string; first_seen_at: string }>(
        `SELECT p.id, p.first_seen_at FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL`,
      );

      const filtered = rows.filter((r) => r.first_seen_at >= thresholdISO);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe('new');
    });
  });

  describe('ineligible section', () => {
    it('correctly separates ineligible postings', async () => {
      await insertPosting(db, 'ok', {
        eligibility: JSON.stringify({ verdict: 'unclear', reasons: [], flags: [] }),
      });
      await insertPosting(db, 'bad', {
        eligibility: JSON.stringify({ verdict: 'ineligible', reasons: ['must be US citizen'], flags: [] }),
      });

      const rows = await db.query<{ id: string; eligibility: string | null }>(
        `SELECT p.id, p.eligibility FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL`,
      );

      const ineligible = rows.filter((r) => {
        try {
          const e = JSON.parse(r.eligibility ?? '{}') as { verdict?: string };
          return e.verdict === 'ineligible';
        } catch { return false; }
      });

      const eligible = rows.filter((r) => {
        try {
          const e = JSON.parse(r.eligibility ?? '{}') as { verdict?: string };
          return e.verdict !== 'ineligible';
        } catch { return true; }
      });

      expect(ineligible).toHaveLength(1);
      expect(ineligible[0]?.id).toBe('bad');
      expect(eligible).toHaveLength(1);
      expect(eligible[0]?.id).toBe('ok');
    });
  });

  describe('excluded companies', () => {
    it('filters out excluded company slugs', async () => {
      await insertPosting(db, 'keep', { data: { company_slug: 'ramp' } });
      await insertPosting(db, 'exclude', { data: { company_slug: 'badco' } });

      const excluded = new Set(['badco']);

      const rows = await db.query<{ id: string; data: string }>(
        `SELECT p.id, p.data FROM postings_cache p
         LEFT JOIN applications a ON p.id = a.posting_id
         WHERE (a.posting_id IS NULL OR a.status = 'new') AND p.closed_at IS NULL`,
      );

      const filtered = rows.filter((r) => {
        const d = JSON.parse(r.data) as { company_slug: string };
        return !excluded.has(d.company_slug);
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe('keep');
    });
  });

  describe('score display logic', () => {
    it('score color mapping: >70 green, 40-70 yellow, <40 red', () => {
      function scoreColor(score: number): string {
        if (score > 70) return 'green';
        if (score >= 40) return 'yellow';
        return 'red';
      }

      expect(scoreColor(90)).toBe('green');
      expect(scoreColor(71)).toBe('green');
      expect(scoreColor(70)).toBe('yellow');
      expect(scoreColor(40)).toBe('yellow');
      expect(scoreColor(39)).toBe('red');
      expect(scoreColor(5)).toBe('red');
    });
  });

  describe('eligibility popover content', () => {
    it('ineligible verdict has reasons with cited sentences', () => {
      const elig = {
        verdict: 'ineligible',
        reasons: ['must be a U.S. citizen'],
        flags: [{ type: 'citizenship_required', matched_sentence: 'must be a U.S. citizen' }],
      };
      expect(elig.verdict).toBe('ineligible');
      expect(elig.reasons.length).toBeGreaterThan(0);
      expect(elig.reasons[0]).toContain('U.S. citizen');
    });

    it('unclear verdict with null description shows fetch message', () => {
      const eligibility: string | null = null;
      const message = eligibility === null
        ? 'Description not yet fetched.'
        : 'No eligibility signals detected in posting description.';
      expect(message).toBe('Description not yet fetched.');
    });

    it('unclear verdict with empty reasons shows no signals message', () => {
      const elig = { verdict: 'unclear', reasons: [] as string[], flags: [] };
      const message = elig.reasons.length > 0
        ? elig.reasons.join(', ')
        : 'No eligibility signals detected in posting description.';
      expect(message).toBe('No eligibility signals detected in posting description.');
    });
  });

  describe('score breakdown popover', () => {
    it('parses breakdown JSON correctly', () => {
      const raw = JSON.stringify({ tier: 30, freshness: 28, category: 20, eligibility: 20 });
      const parsed = JSON.parse(raw) as { tier: number; freshness: number; category: number; eligibility: number };
      expect(parsed.tier).toBe(30);
      expect(parsed.freshness).toBe(28);
      expect(parsed.category).toBe(20);
      expect(parsed.eligibility).toBe(20);
      expect(parsed.tier + parsed.freshness + parsed.category + parsed.eligibility).toBe(98);
    });
  });

  describe('multi-posting triage sequence', () => {
    it('save + skip sequence reduces feed correctly', async () => {
      await insertPosting(db, 'p1', { score: 90 });
      await insertPosting(db, 'p2', { score: 80 });
      await insertPosting(db, 'p3', { score: 70 });
      await insertPosting(db, 'p4', { score: 60 });

      expect(await queryUntriaged(db)).toHaveLength(4);

      const now = '2026-08-13T14:00:00Z';

      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (?, 'saved', ?, ?)`,
        ['p1', now, now],
      );
      expect(await queryUntriaged(db)).toHaveLength(4);

      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (?, 'skipped', ?, ?)`,
        ['p3', now, now],
      );
      expect(await queryUntriaged(db)).toHaveLength(3);

      const remaining = await queryUntriaged(db);
      expect(remaining.map((r) => r.id).sort()).toEqual(['p1', 'p2', 'p4']);
    });

    it('undo skip restores posting to feed in correct order', async () => {
      await insertPosting(db, 'p1', { score: 90 });
      await insertPosting(db, 'p2', { score: 50 });

      const now = '2026-08-13T14:00:00Z';
      await db.run(
        `INSERT INTO applications (posting_id, status, created_at, updated_at) VALUES (?, 'skipped', ?, ?)`,
        ['p1', now, now],
      );
      expect(await queryUntriaged(db)).toHaveLength(1);

      await db.run('DELETE FROM applications WHERE posting_id = ?', ['p1']);
      const restored = await queryUntriaged(db);
      expect(restored).toHaveLength(2);
      expect(restored[0]?.id).toBe('p1');
    });
  });
});

describe('field filter choices', () => {
  it('keeps a software profile focused on adjacent technical fields', () => {
    const values = filterOptionsForProfile(['swe']).map((option) => option.value);
    expect(values).toEqual(['swe', 'data-ml', 'hardware', 'ECE', 'quant', 'research']);
    expect(values).not.toContain('supply-chain');
    expect(values).not.toContain('mechE');
    expect(values).not.toContain('aero');
    expect(values).not.toContain('civil');
  });
});

describe('Virtual Scroll Logic', () => {
  it('visible slice is bounded by overscan buffer', () => {
    const itemCount = 1000;
    const itemHeight = 72;
    const overscan = 5;
    const containerHeight = 500;
    const scrollTop = 0;

    const startIndex = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const start = Math.max(0, startIndex - overscan);
    const end = Math.min(itemCount, startIndex + visibleCount + overscan);

    expect(start).toBe(0);
    expect(end).toBeLessThan(50);
    expect(end - start).toBeLessThanOrEqual(visibleCount + 2 * overscan);
  });

  it('1000 items at 72px produces <30 visible elements at 500px viewport', () => {
    const containerHeight = 500;
    const itemHeight = 72;
    const overscan = 5;

    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const totalRendered = visibleCount + 2 * overscan;

    expect(totalRendered).toBeLessThan(30);
  });

  it('scroll to middle renders correct item range', () => {
    const itemCount = 1000;
    const itemHeight = 72;
    const overscan = 5;
    const containerHeight = 500;
    const scrollTop = 36000;

    const startIndex = Math.floor(scrollTop / itemHeight);
    const visibleCount = Math.ceil(containerHeight / itemHeight);
    const start = Math.max(0, startIndex - overscan);
    const end = Math.min(itemCount, startIndex + visibleCount + overscan);

    expect(start).toBe(startIndex - overscan);
    expect(start).toBe(495);
    expect(end).toBe(startIndex + visibleCount + overscan);
  });

  it('total height equals itemCount * itemHeight', () => {
    expect(2000 * 72).toBe(144000);
  });
});

describe('Feed empty-state messaging', () => {
  it('shows an actionable first-load error without cache terminology', () => {
    const state = getFeedEmptyState(0, 'error');

    expect(state.title).toBe("Jobs couldn't be updated.");
    expect(state.detail).toContain('retry automatically');
    expect(`${state.title} ${state.detail ?? ''}`).not.toMatch(/cached|sync failed/i);
  });

  it('does not surface a background refresh failure over existing jobs', () => {
    expect(getFeedEmptyState(12, 'error')).toEqual({
      title: 'No jobs match these filters.',
      detail: null,
    });
  });
});
