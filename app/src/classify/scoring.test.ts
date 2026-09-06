import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NightjarDB } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import { scorePosting, type ScoringInput } from './scoring';
import { recomputePosting, recomputeNewPostings, recomputeAll } from './recompute';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    graduation: '2029-05',
    grad_window: ['2028-11', '2029-06'],
    current_class_year: 'junior',
    work_auth: 'f1_opt_cpt',
    requires_sponsorship: true,
    target_categories: ['swe', 'quant', 'data-ml'],
    locations: ['US'],
    excluded_companies: [],
    tiers: {},
    contacts: {},
    ...overrides,
  };
}

function makePosting(overrides: Partial<FeedPosting> & { id: string }): FeedPosting {
  return {
    company: 'TestCo',
    company_slug: 'testco',
    title: 'Software Engineering Intern',
    location: 'New York, NY',
    locations: ['New York, NY'],
    url: 'https://boards.greenhouse.io/testco/jobs/123',
    source: 'greenhouse',
    source_job_id: '123',
    ats: 'greenhouse',
    posted_at: '2026-09-15T00:00:00Z',
    first_seen_at: '2026-09-15T00:00:00Z',
    last_seen_at: '2026-10-01T00:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

function makeScoringInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  const category = overrides.category ?? 'swe';
  return {
    company_slug: 'testco',
    first_seen_at: new Date().toISOString(),
    eligibility_verdict: 'unclear',
    category,
    category_tags: overrides.category_tags ?? [category],
    ...overrides,
  };
}

describe('scorePosting — pure scoring function', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  describe('tier signal (0-30 points)', () => {
    it('tier 1 = 30 points', () => {
      const profile = makeProfile({ tiers: { testco: 1 } });
      const result = scorePosting(makeScoringInput({ first_seen_at: now.toISOString() }), profile, now);
      expect(result.breakdown.tier).toBe(30);
    });

    it('tier 2 = 20 points', () => {
      const profile = makeProfile({ tiers: { testco: 2 } });
      const result = scorePosting(makeScoringInput({ first_seen_at: now.toISOString() }), profile, now);
      expect(result.breakdown.tier).toBe(20);
    });

    it('tier 3 = 10 points', () => {
      const profile = makeProfile({ tiers: { testco: 3 } });
      const result = scorePosting(makeScoringInput({ first_seen_at: now.toISOString() }), profile, now);
      expect(result.breakdown.tier).toBe(10);
    });

    it('untiered = 15 points (neutral midpoint)', () => {
      const profile = makeProfile({ tiers: {} });
      const result = scorePosting(makeScoringInput({ first_seen_at: now.toISOString() }), profile, now);
      expect(result.breakdown.tier).toBe(15);
    });
  });

  describe('freshness signal (0-30 points, exponential decay)', () => {
    it('same day = 30 points', () => {
      const result = scorePosting(
        makeScoringInput({ first_seen_at: now.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.freshness).toBe(30);
    });

    it('1 day old ≈ 28-29 points', () => {
      const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
      const result = scorePosting(
        makeScoringInput({ first_seen_at: oneDayAgo.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.freshness).toBeGreaterThanOrEqual(28);
      expect(result.breakdown.freshness).toBeLessThanOrEqual(30);
    });

    it('7 days old ≈ 20-22 points', () => {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const result = scorePosting(
        makeScoringInput({ first_seen_at: sevenDaysAgo.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.freshness).toBeGreaterThanOrEqual(20);
      expect(result.breakdown.freshness).toBeLessThanOrEqual(22);
    });

    it('14 days old ≈ 14-16 points', () => {
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const result = scorePosting(
        makeScoringInput({ first_seen_at: fourteenDaysAgo.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.freshness).toBeGreaterThanOrEqual(14);
      expect(result.breakdown.freshness).toBeLessThanOrEqual(16);
    });

    it('30+ days old = floor at 2 points', () => {
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      const result = scorePosting(
        makeScoringInput({ first_seen_at: sixtyDaysAgo.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.freshness).toBe(2);
    });

    it('future date clamped to 30 (never exceeds max)', () => {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const result = scorePosting(
        makeScoringInput({ first_seen_at: tomorrow.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.freshness).toBe(30);
    });
  });

  describe('category match signal (0-20 points)', () => {
    it('category in target_categories = 20 points', () => {
      const profile = makeProfile({ target_categories: ['swe', 'data-ml'] });
      const result = scorePosting(
        makeScoringInput({ category: 'swe', first_seen_at: now.toISOString() }),
        profile,
        now,
      );
      expect(result.breakdown.category).toBe(20);
    });

    it('category = "other" = 10 points', () => {
      const result = scorePosting(
        makeScoringInput({ category: 'other', first_seen_at: now.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.category).toBe(10);
    });

    it('category not in target_categories = 5 points', () => {
      const profile = makeProfile({ target_categories: ['swe', 'data-ml'] });
      const result = scorePosting(
        makeScoringInput({ category: 'hardware', first_seen_at: now.toISOString() }),
        profile,
        now,
      );
      expect(result.breakdown.category).toBe(5);
    });
  });

  describe('eligibility signal (0-20 points, with override)', () => {
    it('eligible = 20 points', () => {
      const result = scorePosting(
        makeScoringInput({ eligibility_verdict: 'eligible', first_seen_at: now.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.eligibility).toBe(20);
    });

    it('unclear = 15 points', () => {
      const result = scorePosting(
        makeScoringInput({ eligibility_verdict: 'unclear', first_seen_at: now.toISOString() }),
        makeProfile(),
        now,
      );
      expect(result.breakdown.eligibility).toBe(15);
    });

    it('ineligible = 0 points in breakdown, entire score capped at 5', () => {
      const profile = makeProfile({ tiers: { testco: 1 } });
      const result = scorePosting(
        makeScoringInput({
          eligibility_verdict: 'ineligible',
          category: 'swe',
          first_seen_at: now.toISOString(),
        }),
        profile,
        now,
      );
      expect(result.breakdown.eligibility).toBe(0);
      expect(result.score).toBeLessThanOrEqual(5);
    });

    it('ineligible cap works regardless of tier/freshness/category', () => {
      const profile = makeProfile({ tiers: { testco: 1 }, target_categories: ['swe'] });
      const result = scorePosting(
        makeScoringInput({
          eligibility_verdict: 'ineligible',
          category: 'swe',
          first_seen_at: now.toISOString(),
        }),
        profile,
        now,
      );
      expect(result.score).toBe(5);
    });
  });

  describe('composite scores', () => {
    it('tier 1 + fresh + SWE match + eligible = 100', () => {
      const profile = makeProfile({ tiers: { testco: 1 }, target_categories: ['swe'] });
      const result = scorePosting(
        makeScoringInput({
          eligibility_verdict: 'eligible',
          category: 'swe',
          first_seen_at: now.toISOString(),
        }),
        profile,
        now,
      );
      expect(result.score).toBe(100);
      expect(result.breakdown).toEqual({ tier: 30, freshness: 30, category: 20, eligibility: 20 });
    });

    it('tier 3 + 30 days old + "other" category + unclear', () => {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const profile = makeProfile({ tiers: { testco: 3 } });
      const result = scorePosting(
        makeScoringInput({
          eligibility_verdict: 'unclear',
          category: 'other',
          first_seen_at: thirtyDaysAgo.toISOString(),
        }),
        profile,
        now,
      );
      // tier: 10, freshness: 30*e^(-1.5)≈6.69, category: 10, eligibility: 15
      expect(result.score).toBeGreaterThanOrEqual(38);
      expect(result.score).toBeLessThanOrEqual(45);
    });

    it('untiered + 7 days + non-target category + unclear', () => {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const profile = makeProfile({ target_categories: ['data-ml'] });
      const result = scorePosting(
        makeScoringInput({
          eligibility_verdict: 'unclear',
          category: 'hardware',
          first_seen_at: sevenDaysAgo.toISOString(),
        }),
        profile,
        now,
      );
      // tier: 15, freshness: 30*e^(-0.35)≈21.14, category: 5, eligibility: 15 ≈ 56
      expect(result.score).toBeGreaterThanOrEqual(53);
      expect(result.score).toBeLessThanOrEqual(59);
    });

    it('score never exceeds 100', () => {
      const profile = makeProfile({ tiers: { testco: 1 }, target_categories: ['swe'] });
      const result = scorePosting(
        makeScoringInput({
          eligibility_verdict: 'eligible',
          category: 'swe',
          first_seen_at: now.toISOString(),
        }),
        profile,
        now,
      );
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  describe('score ordering', () => {
    it('correctly orders 5 postings by expected ranking', () => {
      const profile = makeProfile({
        tiers: { tier1co: 1, tier2co: 2, tier3co: 3 },
        target_categories: ['swe', 'data-ml'],
      });

      const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const scores = [
        scorePosting(
          { company_slug: 'tier1co', first_seen_at: now.toISOString(), eligibility_verdict: 'eligible', category: 'swe', category_tags: ['swe'] },
          profile, now,
        ),
        scorePosting(
          { company_slug: 'tier2co', first_seen_at: oneDayAgo.toISOString(), eligibility_verdict: 'unclear', category: 'data-ml', category_tags: ['data-ml'] },
          profile, now,
        ),
        scorePosting(
          { company_slug: 'tier3co', first_seen_at: sevenDaysAgo.toISOString(), eligibility_verdict: 'unclear', category: 'other', category_tags: ['other'] },
          profile, now,
        ),
        scorePosting(
          { company_slug: 'tier3co', first_seen_at: thirtyDaysAgo.toISOString(), eligibility_verdict: 'unclear', category: 'hardware', category_tags: ['hardware'] },
          profile, now,
        ),
        scorePosting(
          { company_slug: 'tier1co', first_seen_at: now.toISOString(), eligibility_verdict: 'ineligible', category: 'swe', category_tags: ['swe'] },
          profile, now,
        ),
      ];

      for (let i = 0; i < scores.length - 1; i++) {
        expect(scores[i]!.score).toBeGreaterThanOrEqual(scores[i + 1]!.score);
      }

      expect(scores[4]!.score).toBeLessThanOrEqual(5);
    });
  });

  describe('profile changes affect score', () => {
    it('switching company from tier 3 to tier 1 increases score', () => {
      const input = makeScoringInput({
        first_seen_at: now.toISOString(),
        eligibility_verdict: 'unclear',
        category: 'swe',
      });

      const tier3Profile = makeProfile({ tiers: { testco: 3 } });
      const tier1Profile = makeProfile({ tiers: { testco: 1 } });

      const scoreTier3 = scorePosting(input, tier3Profile, now);
      const scoreTier1 = scorePosting(input, tier1Profile, now);

      expect(scoreTier1.score).toBeGreaterThan(scoreTier3.score);
      expect(scoreTier1.breakdown.tier - scoreTier3.breakdown.tier).toBe(20);
    });

    it('adding category to targets increases score', () => {
      const input = makeScoringInput({
        first_seen_at: now.toISOString(),
        category: 'hardware',
      });

      const withoutHW = makeProfile({ target_categories: ['swe'] });
      const withHW = makeProfile({ target_categories: ['swe', 'hardware'] });

      const scoreBefore = scorePosting(input, withoutHW, now);
      const scoreAfter = scorePosting(input, withHW, now);

      expect(scoreAfter.score).toBeGreaterThan(scoreBefore.score);
      expect(scoreAfter.breakdown.category).toBe(20);
      expect(scoreBefore.breakdown.category).toBe(5);
    });
  });

  describe('freshness decay comparison', () => {
    it('same posting scores higher at day 0 vs day 7', () => {
      const profile = makeProfile();
      const firstSeenAt = '2026-09-15T00:00:00Z';

      const day0 = scorePosting(
        makeScoringInput({ first_seen_at: firstSeenAt }),
        profile,
        new Date('2026-09-15T00:00:00Z'),
      );
      const day7 = scorePosting(
        makeScoringInput({ first_seen_at: firstSeenAt }),
        profile,
        new Date('2026-09-22T00:00:00Z'),
      );

      expect(day0.score).toBeGreaterThan(day7.score);
      expect(day0.breakdown.freshness).toBeGreaterThan(day7.breakdown.freshness);
    });
  });

  describe('breakdown is always present', () => {
    it('includes all four signals', () => {
      const result = scorePosting(makeScoringInput({ first_seen_at: now.toISOString() }), makeProfile(), now);
      expect(result.breakdown).toHaveProperty('tier');
      expect(result.breakdown).toHaveProperty('freshness');
      expect(result.breakdown).toHaveProperty('category');
      expect(result.breakdown).toHaveProperty('eligibility');
    });
  });
});

describe('recompute — DB integration', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertPosting(posting: FeedPosting, description: string | null = null): Promise<void> {
    await db.run(
      `INSERT INTO postings_cache (id, data, description, first_seen_at, closed_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        posting.id,
        JSON.stringify(posting),
        description,
        posting.first_seen_at,
        posting.closed_at ?? null,
        new Date().toISOString(),
      ],
    );
  }

  describe('recomputePosting', () => {
    it('classifies and scores a single posting', async () => {
      const posting = makePosting({ id: 'abc123' });
      await insertPosting(posting);

      const profile = makeProfile({ tiers: { testco: 1 }, target_categories: ['swe'] });
      const now = new Date(posting.first_seen_at);
      const result = await recomputePosting(db, 'abc123', profile, now);

      expect(result).not.toBeNull();
      expect(result!.classification.category.category).toBe('swe');
      expect(result!.score.score).toBeGreaterThan(0);
      expect(result!.score.breakdown.tier).toBe(30);

      const row = await db.queryOne<{ score: number; score_breakdown: string; category: string }>(
        'SELECT score, score_breakdown, category FROM postings_cache WHERE id = ?',
        ['abc123'],
      );
      expect(row).toBeDefined();
      expect(row!.score).toBe(result!.score.score);
      expect(row!.category).toBe('swe');
      const breakdown = JSON.parse(row!.score_breakdown) as Record<string, number>;
      expect(breakdown['tier']).toBe(30);
    });

    it('returns null for nonexistent posting', async () => {
      const result = await recomputePosting(db, 'nonexistent', makeProfile());
      expect(result).toBeNull();
    });
  });

  describe('recomputeNewPostings', () => {
    it('batch classifies and scores multiple postings', async () => {
      const postings = [
        makePosting({ id: 'p1', company_slug: 'acme', title: 'Software Engineer Intern' }),
        makePosting({ id: 'p2', company_slug: 'bigco', title: 'ML Engineer Intern' }),
        makePosting({ id: 'p3', company_slug: 'smallco', title: 'Hardware Intern' }),
      ];
      for (const p of postings) await insertPosting(p);

      const profile = makeProfile({ tiers: { acme: 1, bigco: 2 }, target_categories: ['swe', 'data-ml'] });
      const now = new Date(postings[0]!.first_seen_at);
      const results = await recomputeNewPostings(db, ['p1', 'p2', 'p3'], profile, now);

      expect(results.size).toBe(3);

      for (const id of ['p1', 'p2', 'p3']) {
        const row = await db.queryOne<{ score: number; category: string }>(
          'SELECT score, category FROM postings_cache WHERE id = ?',
          [id],
        );
        expect(row).toBeDefined();
        expect(row!.score).toBeGreaterThan(0);
        expect(row!.category).not.toBeNull();
      }
    });
  });

  describe('recomputeAll', () => {
    it('recomputes all non-closed postings', async () => {
      const open = makePosting({ id: 'open1', closed_at: null });
      const closed = makePosting({ id: 'closed1', closed_at: '2026-09-20T00:00:00Z' });
      await insertPosting(open);
      await insertPosting(closed);

      const profile = makeProfile();
      const count = await recomputeAll(db, profile);

      expect(count).toBe(1);

      const openRow = await db.queryOne<{ score: number }>('SELECT score FROM postings_cache WHERE id = ?', ['open1']);
      expect(openRow!.score).toBeGreaterThan(0);

      const closedRow = await db.queryOne<{ score: number | null }>('SELECT score FROM postings_cache WHERE id = ?', ['closed1']);
      expect(closedRow!.score).toBeNull();
    });
  });

  describe('description triggers rescore', () => {
    it('scoring changes when description reveals ineligibility', async () => {
      const posting = makePosting({ id: 'desc1', description_status: 'available' });
      await insertPosting(posting);

      const profile = makeProfile({ tiers: { testco: 1 }, target_categories: ['swe'] });
      const now = new Date(posting.first_seen_at);

      const before = await recomputePosting(db, 'desc1', profile, now);
      expect(before).not.toBeNull();
      expect(before!.classification.eligibility.verdict).toBe('unclear');
      expect(before!.score.score).toBeGreaterThan(5);

      await db.run(
        'UPDATE postings_cache SET description = ? WHERE id = ?',
        ['This position requires US citizenship. We are unable to sponsor visas for this role.', 'desc1'],
      );

      const after = await recomputePosting(db, 'desc1', profile, now);
      expect(after).not.toBeNull();
      expect(after!.classification.eligibility.verdict).toBe('ineligible');
      expect(after!.score.score).toBeLessThanOrEqual(5);
    });

    it('positive sponsorship is not a general eligibility claim or ranking bonus', async () => {
      const posting = makePosting({ id: 'desc2' });
      await insertPosting(posting);

      const profile = makeProfile({ target_categories: ['swe'] });
      const now = new Date(posting.first_seen_at);

      const before = await recomputePosting(db, 'desc2', profile, now);
      expect(before!.classification.eligibility.verdict).toBe('unclear');
      expect(before!.score.breakdown.eligibility).toBe(15);

      await db.run(
        'UPDATE postings_cache SET description = ? WHERE id = ?',
        ['We sponsor work visas for qualified candidates. Join our team!', 'desc2'],
      );

      const after = await recomputePosting(db, 'desc2', profile, now);
      expect(after!.classification.eligibility.verdict).toBe('unclear');
      expect(after!.score.breakdown.eligibility).toBe(15);
      expect(after!.score.score).toBe(before!.score.score);
    });
  });

  describe('profile change rescores', () => {
    it('tier change from untiered to tier 1 increases score', async () => {
      const posting = makePosting({ id: 'tier-test' });
      await insertPosting(posting);

      const now = new Date(posting.first_seen_at);
      const untierProfile = makeProfile({ tiers: {} });
      const before = await recomputePosting(db, 'tier-test', untierProfile, now);

      const tieredProfile = makeProfile({ tiers: { testco: 1 } });
      const after = await recomputePosting(db, 'tier-test', tieredProfile, now);

      expect(after!.score.score).toBeGreaterThan(before!.score.score);
      expect(after!.score.breakdown.tier).toBe(30);
      expect(before!.score.breakdown.tier).toBe(15);
    });
  });
});
