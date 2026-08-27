import { describe, it, expect, beforeEach } from 'vitest';
import { NightjarDB } from '@/db/database';
import type { Profile } from '@/profile/types';
import { recomputeAll } from '@/classify/recompute';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    graduation: '2029-05',
    grad_window: ['2028-11', '2029-06'] as [string, string],
    current_class_year: 'junior',
    work_auth: 'f1_opt_cpt',
    requires_sponsorship: true,
    target_categories: ['swe', 'quant', 'ml', 'hardware'],
    locations: ['US'],
    excluded_companies: [],
    tiers: {},
    contacts: {},
    ...overrides,
  };
}

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
    eligibility?: string | null;
    first_seen_at?: string;
    closed_at?: string | null;
  } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, category, term, eligibility, score, score_breakdown, synced_at)
     VALUES (?, ?, ?, ?, ?, 'summer_2027', ?, ?, ?, ?)`,
    [
      id,
      makePostingData({ company_slug: id.split('-')[0] ?? id, ...overrides.data }),
      overrides.first_seen_at ?? '2026-08-10T12:00:00Z',
      overrides.closed_at ?? null,
      overrides.category ?? 'swe',
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
    deadline?: string | null;
    notes?: string | null;
    next_action?: string | null;
    next_action_at?: string | null;
    created_at?: string;
    updated_at?: string;
  } = {},
): Promise<void> {
  const now = '2026-08-13T14:00:00Z';
  await db.run(
    `INSERT INTO applications (posting_id, status, applied_at, deadline, notes, next_action, next_action_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      postingId,
      status,
      overrides.applied_at ?? null,
      overrides.deadline ?? null,
      overrides.notes ?? null,
      overrides.next_action ?? null,
      overrides.next_action_at ?? null,
      overrides.created_at ?? now,
      overrides.updated_at ?? now,
    ],
  );
}

describe('Company Detail Data Layer', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  describe('postings tab', () => {
    it('shows all postings for a given company slug', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp', title: 'SWE Intern' } });
      await insertPosting(db, 'ramp-2', { data: { company: 'Ramp', company_slug: 'ramp', title: 'ML Intern' } });
      await insertPosting(db, 'stripe-1', { data: { company: 'Stripe', company_slug: 'stripe', title: 'SWE Intern' } });

      const rows = await db.query<{ id: string; data: string }>(
        'SELECT id, data FROM postings_cache',
      );

      const rampPostings = rows.filter((r) => {
        const d = JSON.parse(r.data) as { company_slug: string };
        return d.company_slug === 'ramp';
      });

      expect(rampPostings).toHaveLength(2);
    });

    it('includes both active and closed postings', async () => {
      await insertPosting(db, 'ramp-1', {
        data: { company: 'Ramp', company_slug: 'ramp', title: 'Active Role' },
      });
      await insertPosting(db, 'ramp-2', {
        data: { company: 'Ramp', company_slug: 'ramp', title: 'Closed Role' },
        closed_at: '2026-08-12T00:00:00Z',
      });

      const rows = await db.query<{ id: string; data: string; closed_at: string | null }>(
        'SELECT id, data, closed_at FROM postings_cache',
      );

      const rampPostings = rows.filter((r) => {
        const d = JSON.parse(r.data) as { company_slug: string };
        return d.company_slug === 'ramp';
      });

      expect(rampPostings).toHaveLength(2);
      const active = rampPostings.filter((r) => r.closed_at === null);
      const closed = rampPostings.filter((r) => r.closed_at !== null);
      expect(active).toHaveLength(1);
      expect(closed).toHaveLength(1);
    });

    it('postings sorted by score descending', async () => {
      await insertPosting(db, 'ramp-1', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        score: 90,
      });
      await insertPosting(db, 'ramp-2', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        score: 40,
      });
      await insertPosting(db, 'ramp-3', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        score: 75,
      });

      const rows = await db.query<{ id: string; data: string; score: number | null }>(
        'SELECT id, data, score FROM postings_cache ORDER BY score DESC',
      );

      const rampPostings = rows.filter((r) => {
        const d = JSON.parse(r.data) as { company_slug: string };
        return d.company_slug === 'ramp';
      });

      expect(rampPostings[0]?.score).toBe(90);
      expect(rampPostings[1]?.score).toBe(75);
      expect(rampPostings[2]?.score).toBe(40);
    });
  });

  describe('applications tab', () => {
    it('shows applications for company postings', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'ramp-2', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'applied', {
        applied_at: '2026-08-15T00:00:00Z',
      });
      await createApplication(db, 'ramp-2', 'saved');

      const postingIds = ['ramp-1', 'ramp-2'];
      const placeholders = postingIds.map(() => '?').join(',');

      const apps = await db.query<{ posting_id: string; status: string }>(
        `SELECT posting_id, status FROM applications WHERE posting_id IN (${placeholders}) ORDER BY updated_at DESC`,
        postingIds,
      );

      expect(apps).toHaveLength(2);
      const statuses = apps.map((a) => a.status).sort();
      expect(statuses).toEqual(['applied', 'saved']);
    });

    it('inline status change persists', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await createApplication(db, 'ramp-1', 'applied');

      const now = '2026-08-20T10:00:00Z';
      await db.run(
        'UPDATE applications SET status = ?, updated_at = ? WHERE posting_id = ?',
        ['phone', now, 'ramp-1'],
      );

      const row = await db.queryOne<{ status: string; updated_at: string }>(
        'SELECT status, updated_at FROM applications WHERE posting_id = ?',
        ['ramp-1'],
      );

      expect(row?.status).toBe('phone');
      expect(row?.updated_at).toBe(now);
    });
  });

  describe('stats', () => {
    it('correct active/closed/application counts', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'ramp-2', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'ramp-3', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        closed_at: '2026-08-12T00:00:00Z',
      });
      await createApplication(db, 'ramp-1', 'applied');

      const rows = await db.query<{ id: string; data: string; closed_at: string | null }>(
        'SELECT id, data, closed_at FROM postings_cache',
      );

      const rampPostings = rows.filter((r) => {
        const d = JSON.parse(r.data) as { company_slug: string };
        return d.company_slug === 'ramp';
      });

      const activeCount = rampPostings.filter((r) => r.closed_at === null).length;
      const closedCount = rampPostings.filter((r) => r.closed_at !== null).length;

      expect(rampPostings).toHaveLength(3);
      expect(activeCount).toBe(2);
      expect(closedCount).toBe(1);

      const postingIds = rampPostings.map((r) => r.id);
      const placeholders = postingIds.map(() => '?').join(',');
      const apps = await db.query<{ posting_id: string }>(
        `SELECT posting_id FROM applications WHERE posting_id IN (${placeholders})`,
        postingIds,
      );
      expect(apps).toHaveLength(1);
    });

    it('latest posting date computed correctly', async () => {
      await insertPosting(db, 'ramp-1', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        first_seen_at: '2026-08-01T00:00:00Z',
      });
      await insertPosting(db, 'ramp-2', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        first_seen_at: '2026-08-15T00:00:00Z',
      });
      await insertPosting(db, 'ramp-3', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        first_seen_at: '2026-08-10T00:00:00Z',
      });

      const rows = await db.query<{ data: string; first_seen_at: string | null }>(
        'SELECT data, first_seen_at FROM postings_cache',
      );

      const rampDates = rows
        .filter((r) => {
          const d = JSON.parse(r.data) as { company_slug: string };
          return d.company_slug === 'ramp';
        })
        .map((r) => r.first_seen_at)
        .filter((d): d is string => d !== null);

      const latest = rampDates.sort().reverse()[0];
      expect(latest).toBe('2026-08-15T00:00:00Z');
    });
  });

  describe('timeline', () => {
    it('timeline entries from postings and applications', async () => {
      await insertPosting(db, 'ramp-1', {
        data: { company: 'Ramp', company_slug: 'ramp', title: 'SWE Intern' },
        first_seen_at: '2026-08-01T00:00:00Z',
      });
      await createApplication(db, 'ramp-1', 'applied', {
        applied_at: '2026-08-10T00:00:00Z',
        updated_at: '2026-08-10T00:00:00Z',
      });

      const postings = await db.query<{ data: string; first_seen_at: string | null; closed_at: string | null }>(
        'SELECT data, first_seen_at, closed_at FROM postings_cache',
      );
      const apps = await db.query<{ posting_id: string; applied_at: string | null; updated_at: string; status: string }>(
        'SELECT posting_id, applied_at, updated_at, status FROM applications',
      );

      const entries: { date: string; type: string }[] = [];

      for (const p of postings) {
        if (p.first_seen_at) entries.push({ date: p.first_seen_at, type: 'posting' });
        if (p.closed_at) entries.push({ date: p.closed_at, type: 'closed' });
      }
      for (const a of apps) {
        if (a.applied_at) entries.push({ date: a.applied_at, type: 'applied' });
        entries.push({ date: a.updated_at, type: 'status' });
      }

      entries.sort((a, b) => b.date.localeCompare(a.date));

      expect(entries).toHaveLength(3);
      expect(entries[0]?.type).toBe('applied');
      expect(entries[1]?.type).toBe('status');
      expect(entries[2]?.type).toBe('posting');
    });
  });

  describe('tier change from detail view', () => {
    it('tier change triggers recompute and updates scores', async () => {
      await insertPosting(db, 'ramp-1', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        score: 60,
      });

      const before = await db.queryOne<{ score: number }>(
        'SELECT score FROM postings_cache WHERE id = ?',
        ['ramp-1'],
      );
      expect(before?.score).toBe(60);

      const profile = makeProfile({ tiers: { ramp: 1 } });
      await recomputeAll(db, profile);

      const after = await db.queryOne<{ score: number | null }>(
        'SELECT score FROM postings_cache WHERE id = ?',
        ['ramp-1'],
      );
      expect(after?.score).not.toBeNull();
      expect(after!.score).not.toBe(60);
    });
  });

  describe('contact notes from detail view', () => {
    it('contact notes save to and read from profile', () => {
      const profile = makeProfile();
      const newContacts = { ...profile.contacts, ramp: 'Warm intro via Sarah, applied Oct 2026' };
      profile.contacts = newContacts;

      expect(profile.contacts['ramp']).toBe('Warm intro via Sarah, applied Oct 2026');
    });

    it('clearing contact deletes key', () => {
      const profile = makeProfile({ contacts: { ramp: 'Some note' } });
      const newContacts = { ...profile.contacts };
      delete newContacts['ramp'];
      profile.contacts = newContacts;

      expect(profile.contacts['ramp']).toBeUndefined();
    });
  });

  describe('exclude from detail view', () => {
    it('excluding company adds to excluded_companies', () => {
      const profile = makeProfile();
      const excluded = new Set(profile.excluded_companies);
      excluded.add('ramp');
      profile.excluded_companies = Array.from(excluded);

      expect(profile.excluded_companies).toContain('ramp');
    });

    it('un-excluding removes from excluded_companies', () => {
      const profile = makeProfile({ excluded_companies: ['ramp'] });
      const excluded = new Set(profile.excluded_companies);
      excluded.delete('ramp');
      profile.excluded_companies = Array.from(excluded);

      expect(profile.excluded_companies).not.toContain('ramp');
    });
  });

  describe('navigation', () => {
    it('company slug from postings matches route param', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });

      const row = await db.queryOne<{ data: string }>(
        'SELECT data FROM postings_cache WHERE id = ?',
        ['ramp-1'],
      );

      const parsed = JSON.parse(row!.data) as { company_slug: string };
      expect(parsed.company_slug).toBe('ramp');
    });
  });
});
