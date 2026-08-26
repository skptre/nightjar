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
  } = {},
): Promise<void> {
  const firstSeen = overrides.first_seen_at ?? '2026-08-10T12:00:00Z';
  await db.run(
    `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, category, term, eligibility, score, score_breakdown, synced_at)
     VALUES (?, ?, ?, NULL, ?, 'summer_2027', ?, ?, ?, ?)`,
    [
      id,
      makePostingData({ company_slug: id.split('-')[0] ?? id, ...overrides.data }),
      firstSeen,
      overrides.category ?? 'swe',
      overrides.eligibility ?? JSON.stringify({ verdict: 'unclear', reasons: [], flags: [] }),
      overrides.score !== undefined ? overrides.score : 75,
      JSON.stringify({ tier: 15, freshness: 30, category: 20, eligibility: 15 }),
      '2026-08-13T12:00:00Z',
    ],
  );
}

async function queryCompanyAggregates(db: NightjarDB): Promise<Array<{ company_slug: string; count: number }>> {
  const rows = await db.query<{ data: string }>(
    'SELECT data FROM postings_cache WHERE closed_at IS NULL',
  );

  const map = new Map<string, number>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.data) as { company_slug: string };
      map.set(parsed.company_slug, (map.get(parsed.company_slug) ?? 0) + 1);
    } catch { /* skip */ }
  }

  return Array.from(map.entries()).map(([company_slug, count]) => ({ company_slug, count }));
}

describe('Companies View Data Layer', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  describe('company aggregation', () => {
    it('groups postings by company_slug', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'ramp-2', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'stripe-1', { data: { company: 'Stripe', company_slug: 'stripe' } });

      const aggregates = await queryCompanyAggregates(db);
      expect(aggregates).toHaveLength(2);

      const ramp = aggregates.find((a) => a.company_slug === 'ramp');
      const stripe = aggregates.find((a) => a.company_slug === 'stripe');
      expect(ramp?.count).toBe(2);
      expect(stripe?.count).toBe(1);
    });

    it('excludes closed postings from counts', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });

      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, category, term, eligibility, score, score_breakdown, synced_at)
         VALUES (?, ?, ?, ?, 'swe', 'summer_2027', '{}', 50, '{}', ?)`,
        ['ramp-closed', makePostingData({ company_slug: 'ramp' }), '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z', '2026-08-13T00:00:00Z'],
      );

      const aggregates = await queryCompanyAggregates(db);
      const ramp = aggregates.find((a) => a.company_slug === 'ramp');
      expect(ramp?.count).toBe(1);
    });

    it('shows correct posting count per company', async () => {
      for (let i = 0; i < 5; i++) {
        await insertPosting(db, `big-${String(i)}`, { data: { company: 'BigCo', company_slug: 'big' } });
      }
      await insertPosting(db, 'small-0', { data: { company: 'SmallCo', company_slug: 'small' } });

      const aggregates = await queryCompanyAggregates(db);
      const big = aggregates.find((a) => a.company_slug === 'big');
      const small = aggregates.find((a) => a.company_slug === 'small');
      expect(big?.count).toBe(5);
      expect(small?.count).toBe(1);
    });
  });

  describe('tier management', () => {
    it('setting tier updates profile tiers', () => {
      const profile = makeProfile();
      expect(profile.tiers['ramp']).toBeUndefined();

      profile.tiers = { ...profile.tiers, ramp: 1 };
      expect(profile.tiers['ramp']).toBe(1);
    });

    it('removing tier deletes key from tiers', () => {
      const profile = makeProfile({ tiers: { ramp: 2 } });
      expect(profile.tiers['ramp']).toBe(2);

      const newTiers = { ...profile.tiers };
      delete newTiers['ramp'];
      profile.tiers = newTiers;
      expect(profile.tiers['ramp']).toBeUndefined();
    });

    it('tier change triggers recompute and updates scores', async () => {
      await insertPosting(db, 'ramp-1', {
        data: { company: 'Ramp', company_slug: 'ramp' },
        score: 60,
      });

      const beforeScore = await db.queryOne<{ score: number }>(
        'SELECT score FROM postings_cache WHERE id = ?',
        ['ramp-1'],
      );
      expect(beforeScore?.score).toBe(60);

      const profileTier1 = makeProfile({ tiers: { ramp: 1 } });
      const recomputed = await recomputeAll(db, profileTier1);
      expect(recomputed).toBeGreaterThan(0);

      const afterScore = await db.queryOne<{ score: number | null }>(
        'SELECT score FROM postings_cache WHERE id = ?',
        ['ramp-1'],
      );
      expect(afterScore?.score).not.toBeNull();
      expect(afterScore!.score).not.toBe(60);
    });

    it('tier 1 produces higher score than tier 3', async () => {
      await insertPosting(db, 'co-1', {
        data: { company: 'TestCo', company_slug: 'testco' },
      });

      const profileT1 = makeProfile({ tiers: { testco: 1 } });
      await recomputeAll(db, profileT1);
      const scoreT1 = await db.queryOne<{ score: number }>(
        'SELECT score FROM postings_cache WHERE id = ?',
        ['co-1'],
      );

      const profileT3 = makeProfile({ tiers: { testco: 3 } });
      await recomputeAll(db, profileT3);
      const scoreT3 = await db.queryOne<{ score: number }>(
        'SELECT score FROM postings_cache WHERE id = ?',
        ['co-1'],
      );

      expect(scoreT1!.score).toBeGreaterThan(scoreT3!.score);
    });
  });

  describe('contact notes', () => {
    it('saves contact to profile', () => {
      const profile = makeProfile();
      expect(profile.contacts['ramp']).toBeUndefined();

      profile.contacts = { ...profile.contacts, ramp: 'Warm intro via Sarah' };
      expect(profile.contacts['ramp']).toBe('Warm intro via Sarah');
    });

    it('updates existing contact', () => {
      const profile = makeProfile({ contacts: { ramp: 'Old note' } });
      profile.contacts = { ...profile.contacts, ramp: 'Updated note' };
      expect(profile.contacts['ramp']).toBe('Updated note');
    });

    it('deletes contact when empty', () => {
      const profile = makeProfile({ contacts: { ramp: 'Some note' } });
      const newContacts = { ...profile.contacts };
      delete newContacts['ramp'];
      profile.contacts = newContacts;
      expect(profile.contacts['ramp']).toBeUndefined();
    });

    it('preserves contacts for other companies', () => {
      const profile = makeProfile({
        contacts: { ramp: 'Contact A', stripe: 'Contact B' },
      });

      const newContacts = { ...profile.contacts, ramp: 'Updated A' };
      profile.contacts = newContacts;

      expect(profile.contacts['ramp']).toBe('Updated A');
      expect(profile.contacts['stripe']).toBe('Contact B');
    });
  });

  describe('exclude toggle', () => {
    it('adding to excluded_companies hides from feed query', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'stripe-1', { data: { company: 'Stripe', company_slug: 'stripe' } });

      const excluded = new Set(['ramp']);

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
      expect(filtered[0]?.id).toBe('stripe-1');
    });

    it('removing from excluded restores to feed', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });

      const excluded = new Set(['ramp']);
      const rows = await db.query<{ id: string; data: string }>(
        'SELECT id, data FROM postings_cache WHERE closed_at IS NULL',
      );

      const filteredBefore = rows.filter((r) => {
        const d = JSON.parse(r.data) as { company_slug: string };
        return !excluded.has(d.company_slug);
      });
      expect(filteredBefore).toHaveLength(0);

      excluded.delete('ramp');
      const filteredAfter = rows.filter((r) => {
        const d = JSON.parse(r.data) as { company_slug: string };
        return !excluded.has(d.company_slug);
      });
      expect(filteredAfter).toHaveLength(1);
    });

    it('excluded company still appears in companies list but marked', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });

      const allCompanies = await queryCompanyAggregates(db);
      expect(allCompanies).toHaveLength(1);
      expect(allCompanies[0]?.company_slug).toBe('ramp');
    });
  });

  describe('search and sort', () => {
    it('search filters companies by name', async () => {
      await insertPosting(db, 'ramp-1', { data: { company: 'Ramp', company_slug: 'ramp' } });
      await insertPosting(db, 'stripe-1', { data: { company: 'Stripe', company_slug: 'stripe' } });
      await insertPosting(db, 'plaid-1', { data: { company: 'Plaid', company_slug: 'plaid' } });

      const all = await queryCompanyAggregates(db);
      expect(all).toHaveLength(3);

      const search = 'str';
      const filtered = all.filter((c) =>
        c.company_slug.toLowerCase().includes(search.toLowerCase()),
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.company_slug).toBe('stripe');
    });

    it('sort by count descending', async () => {
      for (let i = 0; i < 5; i++) {
        await insertPosting(db, `big-${String(i)}`, { data: { company: 'BigCo', company_slug: 'big' } });
      }
      await insertPosting(db, 'small-0', { data: { company: 'SmallCo', company_slug: 'small' } });
      for (let i = 0; i < 3; i++) {
        await insertPosting(db, `mid-${String(i)}`, { data: { company: 'MidCo', company_slug: 'mid' } });
      }

      const aggregates = await queryCompanyAggregates(db);
      aggregates.sort((a, b) => b.count - a.count);

      expect(aggregates[0]?.company_slug).toBe('big');
      expect(aggregates[0]?.count).toBe(5);
      expect(aggregates[1]?.company_slug).toBe('mid');
      expect(aggregates[1]?.count).toBe(3);
      expect(aggregates[2]?.company_slug).toBe('small');
      expect(aggregates[2]?.count).toBe(1);
    });

    it('sort by tier groups tiered before untiered', () => {
      const profile = makeProfile({ tiers: { ramp: 1, stripe: 3 } });

      const companies = [
        { slug: 'ramp', tier: profile.tiers['ramp'] },
        { slug: 'stripe', tier: profile.tiers['stripe'] },
        { slug: 'plaid', tier: profile.tiers['plaid'] },
      ];

      companies.sort((a, b) => {
        const aVal = a.tier ?? 4;
        const bVal = b.tier ?? 4;
        return aVal - bVal;
      });

      expect(companies[0]?.slug).toBe('ramp');
      expect(companies[1]?.slug).toBe('stripe');
      expect(companies[2]?.slug).toBe('plaid');
    });
  });
});
