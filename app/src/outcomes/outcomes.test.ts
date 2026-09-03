import { beforeEach, describe, expect, it } from 'vitest';
import { NightjarDB } from '@/db/database';
import type { Profile } from '@/profile/types';
import { scorePosting } from '@/classify/scoring';
import {
  recordApplicationOutcome,
  transitionApplicationStatus,
  loadSuggestionDecisions,
  saveSuggestionDecision,
} from './outcome-service';
import {
  EMPTY_INSIGHTS_MESSAGE,
  analyzeOutcomeHistory,
  applySuggestionToProfile,
  calculateOutcomeStats,
  loadOutcomeRecords,
  type OutcomeRecord,
  type RecalibrationSuggestion,
} from '@/engine/recalibrate';

const BASE_PROFILE: Profile = {
  graduation: '2029-05',
  grad_window: ['2028-11', '2029-06'],
  current_class_year: 'junior',
  work_auth: 'us_citizen',
  requires_sponsorship: false,
  target_categories: ['swe'],
  locations: ['US'],
  excluded_companies: [],
  tiers: { tier1co: 1, tier2co: 2, tier3co: 3 },
  contacts: {},
};

function outcomeRecord(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    postingId: 'posting-1',
    companySlug: 'tier2co',
    companyName: 'Tier Two Co',
    category: 'swe',
    tier: 2,
    source: 'greenhouse',
    postedAt: '2026-08-29T00:00:00.000Z',
    appliedAt: '2026-09-01T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

async function insertApplication(db: NightjarDB, postingId = 'posting-1'): Promise<void> {
  const now = '2026-09-01T00:00:00.000Z';
  await db.run(
    `INSERT INTO postings_cache (id, data, category, synced_at)
     VALUES (?, ?, ?, ?)`,
    [
      postingId,
      JSON.stringify({
        id: postingId,
        company: 'Example Co',
        company_slug: 'example-co',
        source: 'greenhouse',
        posted_at: '2026-08-30T00:00:00.000Z',
      }),
      'swe',
      now,
    ],
  );
  await db.run(
    `INSERT INTO applications (posting_id, status, created_at, updated_at)
     VALUES (?, 'saved', ?, ?)`,
    [postingId, now, now],
  );
}

describe('Block 8 outcome persistence', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
    await insertApplication(db);
  });

  it('records an interview transition with optional details and an event', async () => {
    const now = new Date('2026-09-03T12:00:00.000Z');
    await transitionApplicationStatus(
      db,
      'posting-1',
      'phone',
      { notes: 'Strong technical conversation.', interviewRounds: 2 },
      now,
    );

    const application = await db.queryOne<{
      status: string;
      applied_at: string;
      outcome: string;
      outcome_at: string;
      interview_rounds: number;
      outcome_notes: string;
    }>('SELECT * FROM applications WHERE posting_id = ?', ['posting-1']);
    expect(application).toMatchObject({
      status: 'phone',
      applied_at: now.toISOString(),
      outcome: 'interview',
      outcome_at: now.toISOString(),
      interview_rounds: 2,
      outcome_notes: 'Strong technical conversation.',
    });

    const events = await db.query<{ outcome: string; notes: string; interview_rounds: number }>(
      'SELECT outcome, notes, interview_rounds FROM application_outcome_events WHERE posting_id = ?',
      ['posting-1'],
    );
    expect(events).toEqual([
      { outcome: 'interview', notes: 'Strong technical conversation.', interview_rounds: 2 },
    ]);
  });

  it('allows details to be skipped while still recording a terminal outcome', async () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    await transitionApplicationStatus(db, 'posting-1', 'rejected', {}, now);

    const application = await db.queryOne<{
      status: string;
      outcome: string;
      outcome_notes: string | null;
      interview_rounds: number;
    }>('SELECT status, outcome, outcome_notes, interview_rounds FROM applications WHERE posting_id = ?', ['posting-1']);
    expect(application).toEqual({
      status: 'rejected',
      outcome: 'rejection',
      outcome_notes: null,
      interview_rounds: 0,
    });
  });

  it('preserves interview history when the eventual result is rejection', async () => {
    await transitionApplicationStatus(
      db,
      'posting-1',
      'phone',
      { interviewRounds: 1 },
      new Date('2026-09-03T00:00:00.000Z'),
    );
    await transitionApplicationStatus(
      db,
      'posting-1',
      'rejected',
      { notes: 'Role was filled.' },
      new Date('2026-09-10T00:00:00.000Z'),
    );

    const events = await db.query<{ outcome: string }>(
      'SELECT outcome FROM application_outcome_events WHERE posting_id = ? ORDER BY id',
      ['posting-1'],
    );
    expect(events.map((event) => event.outcome)).toEqual(['interview', 'rejection']);

    const application = await db.queryOne<{ outcome: string; interview_rounds: number }>(
      'SELECT outcome, interview_rounds FROM applications WHERE posting_id = ?',
      ['posting-1'],
    );
    expect(application).toEqual({ outcome: 'rejection', interview_rounds: 1 });
  });

  it('sets applied_at once and preserves the original application time', async () => {
    const appliedAt = new Date('2026-09-02T00:00:00.000Z');
    await transitionApplicationStatus(db, 'posting-1', 'applied', {}, appliedAt);
    await transitionApplicationStatus(
      db,
      'posting-1',
      'offer',
      {},
      new Date('2026-09-20T00:00:00.000Z'),
    );

    const application = await db.queryOne<{ applied_at: string }>(
      'SELECT applied_at FROM applications WHERE posting_id = ?',
      ['posting-1'],
    );
    expect(application?.applied_at).toBe(appliedAt.toISOString());
  });

  it('supports recording a withdrawn outcome without inventing a pipeline status', async () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    await recordApplicationOutcome(
      db,
      'posting-1',
      'withdrawn',
      { notes: 'Accepted another role.' },
      now,
    );

    const application = await db.queryOne<{ status: string; outcome: string; outcome_notes: string }>(
      'SELECT status, outcome, outcome_notes FROM applications WHERE posting_id = ?',
      ['posting-1'],
    );
    expect(application).toEqual({
      status: 'saved',
      outcome: 'withdrawn',
      outcome_notes: 'Accepted another role.',
    });
  });

  it('normalizes interview rounds and trims excessively long notes', async () => {
    await transitionApplicationStatus(
      db,
      'posting-1',
      'onsite',
      { interviewRounds: 99.8, notes: `  ${'x'.repeat(450)}  ` },
      new Date('2026-09-06T00:00:00.000Z'),
    );
    const application = await db.queryOne<{ interview_rounds: number; outcome_notes: string }>(
      'SELECT interview_rounds, outcome_notes FROM applications WHERE posting_id = ?',
      ['posting-1'],
    );
    expect(application?.interview_rounds).toBe(20);
    expect(application?.outcome_notes).toHaveLength(400);
  });

  it('persists applied and dismissed suggestion decisions locally', async () => {
    const actedAt = new Date('2026-09-07T00:00:00.000Z');
    await saveSuggestionDecision(db, 'tier:2', 'applied', actedAt);
    await saveSuggestionDecision(db, 'category:mechE', 'dismissed', actedAt);

    expect(await loadSuggestionDecisions(db)).toEqual({
      'category:mechE': 'dismissed',
      'tier:2': 'applied',
    });
  });

  it('loads persisted application and event history into recalibration records', async () => {
    await transitionApplicationStatus(
      db,
      'posting-1',
      'phone',
      { interviewRounds: 1, notes: 'Recruiter screen.' },
      new Date('2026-09-03T00:00:00.000Z'),
    );

    const records = await loadOutcomeRecords(db, {
      ...BASE_PROFILE,
      tiers: { 'example-co': 2 },
    });

    expect(records).toEqual([expect.objectContaining({
      postingId: 'posting-1',
      companySlug: 'example-co',
      companyName: 'Example Co',
      category: 'swe',
      tier: 2,
      source: 'greenhouse',
      postedAt: '2026-08-30T00:00:00.000Z',
      appliedAt: '2026-09-03T00:00:00.000Z',
      events: [{
        outcome: 'interview',
        occurredAt: '2026-09-03T00:00:00.000Z',
        interviewRounds: 1,
        notes: 'Recruiter screen.',
      }],
    })]);
  });
});

describe('Block 8 statistics', () => {
  const records: OutcomeRecord[] = [
    outcomeRecord({
      postingId: 'me-1',
      category: 'mechE',
      tier: 2,
      appliedAt: '2026-09-01T00:00:00.000Z',
      events: [
        { outcome: 'interview', occurredAt: '2026-09-03T00:00:00.000Z', interviewRounds: 1, notes: null },
        { outcome: 'offer', occurredAt: '2026-09-10T00:00:00.000Z', interviewRounds: 3, notes: null },
      ],
    }),
    outcomeRecord({
      postingId: 'swe-1',
      companySlug: 'tier1co',
      companyName: 'Tier One Co',
      category: 'swe',
      tier: 1,
      appliedAt: '2026-09-01T00:00:00.000Z',
      events: [
        { outcome: 'rejection', occurredAt: '2026-09-04T00:00:00.000Z', interviewRounds: 0, notes: null },
      ],
    }),
    outcomeRecord({
      postingId: 'me-2',
      category: 'mechE',
      tier: 2,
      appliedAt: '2026-09-02T00:00:00.000Z',
      events: [
        { outcome: 'ghosted', occurredAt: '2026-10-20T00:00:00.000Z', interviewRounds: 0, notes: null },
      ],
    }),
    outcomeRecord({
      postingId: 'fin-1',
      companySlug: 'unranked',
      companyName: 'Unranked Co',
      category: 'finance',
      tier: null,
      appliedAt: '2026-09-02T00:00:00.000Z',
      events: [
        { outcome: 'interview', occurredAt: '2026-09-03T00:00:00.000Z', interviewRounds: 1, notes: null },
      ],
    }),
  ];

  it('calculates rates, first-response time, category, tier, and timeline totals', () => {
    const stats = calculateOutcomeStats(records);
    expect(stats.applicationsSent).toBe(4);
    expect(stats.interviewed).toBe(2);
    expect(stats.offers).toBe(1);
    expect(stats.interviewRate).toBe(50);
    expect(stats.offerRate).toBe(25);
    expect(stats.averageResponseDays).toBe(2);

    expect(stats.byCategory.find((row) => row.key === 'mechE')).toMatchObject({
      applied: 2,
      interviewed: 1,
      offered: 1,
      ghosted: 1,
    });
    expect(stats.byTier.find((row) => row.key === '2')).toMatchObject({
      applied: 2,
      interviewed: 1,
      offered: 1,
      ghosted: 1,
    });
    expect(stats.timeline.reduce((sum, point) => sum + point.applications, 0)).toBe(4);
    expect(stats.timeline.reduce((sum, point) => sum + point.interviews, 0)).toBe(2);
  });

  it('returns safe zero-state statistics', () => {
    expect(calculateOutcomeStats([])).toMatchObject({
      applicationsSent: 0,
      interviewed: 0,
      offers: 0,
      interviewRate: 0,
      offerRate: 0,
      averageResponseDays: null,
      byCategory: [],
      byTier: [],
      timeline: [],
    });
  });
});

describe('Block 8 recalibration', () => {
  it('shows the planned empty state and does not manufacture suggestions', () => {
    const analysis = analyzeOutcomeHistory([]);
    expect(analysis.ready).toBe(false);
    expect(analysis.message).toBe(EMPTY_INSIGHTS_MESSAGE);
    expect(analysis.suggestions).toEqual([]);
  });

  it('waits for ten recorded outcomes before suggesting adjustments', () => {
    const records = Array.from({ length: 9 }, (_, index) => outcomeRecord({
      postingId: `pending-${String(index)}`,
      events: [{
        outcome: 'rejection',
        occurredAt: `2026-09-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
        interviewRounds: 0,
        notes: null,
      }],
    }));
    const analysis = analyzeOutcomeHistory(records);
    expect(analysis.ready).toBe(false);
    expect(analysis.message).toContain('9 recorded outcomes');
    expect(analysis.suggestions).toEqual([]);
  });

  it('produces cautious, sample-sized suggestions after fifteen outcomes', () => {
    const records = Array.from({ length: 15 }, (_, index) => {
      const tier = index < 8 ? 2 : 1;
      const interviewed = (tier === 2 && index < 5) || (tier === 1 && index === 8);
      return outcomeRecord({
        postingId: `sample-${String(index)}`,
        companySlug: tier === 2 ? 'tier2co' : 'tier1co',
        tier,
        category: tier === 2 ? 'mechE' : 'swe',
        events: [{
          outcome: interviewed ? 'interview' : 'rejection',
          occurredAt: `2026-09-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
          interviewRounds: interviewed ? 1 : 0,
          notes: null,
        }],
      });
    });

    const analysis = analyzeOutcomeHistory(records);
    expect(analysis.ready).toBe(true);
    expect(analysis.recordedOutcomeCount).toBe(15);
    expect(analysis.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of analysis.suggestions) {
      expect(suggestion.message).toContain('Pattern in your history');
      expect(suggestion.message).toMatch(/\b\d+ (?:applications|outcomes)\b/);
      expect(suggestion.message.toLowerCase()).not.toContain('statistically significant');
      expect(suggestion.message.toLowerCase()).not.toContain('caused');
    }
  });

  it('uses supportive language when every recorded outcome is a rejection', () => {
    const records = Array.from({ length: 10 }, (_, index) => outcomeRecord({
      postingId: `rejected-${String(index)}`,
      events: [{
        outcome: 'rejection',
        occurredAt: `2026-09-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
        interviewRounds: 0,
        notes: null,
      }],
    }));
    const analysis = analyzeOutcomeHistory(records);
    expect(analysis.message).toContain('Patterns can change as you add more applications');
    expect(analysis.message.toLowerCase()).not.toContain('failure');
  });

  it('describes ATS patterns without claiming the ATS caused the outcome', () => {
    const records = Array.from({ length: 10 }, (_, index) => outcomeRecord({
      postingId: `source-${String(index)}`,
      source: index < 7 ? 'greenhouse' : 'lever',
      events: [{
        outcome: index < 5 ? 'interview' : 'rejection',
        occurredAt: `2026-09-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
        interviewRounds: index < 5 ? 1 : 0,
        notes: null,
      }],
    }));
    const analysis = analyzeOutcomeHistory(records);
    expect(analysis.observations.some((text) => text.includes('does not measure ATS quality'))).toBe(true);
  });

  it('compares company response times using company-level samples', () => {
    const records = Array.from({ length: 10 }, (_, index) => {
      const fast = index < 4;
      const responseDays = fast ? (index % 2) + 1 : 5 + (index % 2);
      return outcomeRecord({
        postingId: `company-${String(index)}`,
        companySlug: fast ? 'fast-co' : 'slow-co',
        companyName: fast ? 'Fast Co' : 'Slow Co',
        events: [{
          outcome: 'rejection',
          occurredAt: new Date(Date.UTC(2026, 8, 1 + responseDays)).toISOString(),
          interviewRounds: 0,
          notes: null,
        }],
      });
    });

    const analysis = analyzeOutcomeHistory(records);
    expect(analysis.observations.some((text) => (
      text.includes('Fast Co')
      && text.includes('4 applications')
      && text.includes('average response')
    ))).toBe(true);
  });

  it('surfaces descriptive ghost-rate patterns by tier with sample sizes', () => {
    const records = Array.from({ length: 10 }, (_, index) => {
      const tier = index < 5 ? 1 : 2;
      const ghosted = tier === 1 ? index < 4 : index === 5;
      return outcomeRecord({
        postingId: `ghost-${String(index)}`,
        tier,
        events: [{
          outcome: ghosted ? 'ghosted' : 'rejection',
          occurredAt: `2026-09-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`,
          interviewRounds: 0,
          notes: null,
        }],
      });
    });

    const analysis = analyzeOutcomeHistory(records);
    expect(analysis.observations.some((text) => (
      text.includes('Tier 1')
      && text.includes('80%')
      && text.includes('5 applications')
    ))).toBe(true);
  });

  it('applies a tier suggestion only after explicit confirmation', () => {
    const suggestion: RecalibrationSuggestion = {
      id: 'tier:2',
      message: 'Pattern in your history (15 applications): Tier 2 performed better.',
      adjustment: { kind: 'tier_bonus', tier: 2, points: 5 },
    };
    const adjusted = applySuggestionToProfile(BASE_PROFILE, suggestion);
    expect(BASE_PROFILE.scoring_adjustments).toBeUndefined();
    expect(adjusted.scoring_adjustments?.tier_bonus?.['2']).toBe(5);

    const input = {
      company_slug: 'tier2co',
      first_seen_at: '2026-09-03T00:00:00.000Z',
      eligibility_verdict: 'eligible' as const,
      category: 'swe' as const,
      category_tags: ['swe'] as const,
    };
    const before = scorePosting(input, BASE_PROFILE, new Date('2026-09-03T00:00:00.000Z'));
    const after = scorePosting(input, adjusted, new Date('2026-09-03T00:00:00.000Z'));
    expect(after.breakdown.tier - before.breakdown.tier).toBe(5);
  });
});
