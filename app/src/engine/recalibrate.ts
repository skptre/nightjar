import { CATEGORY_OPTIONS, normalizeCategoryValue, type CategoryValue } from '@/classify/types';
import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { ApplicationOutcome, OutcomeEvent } from '@/outcomes/types';

export const EMPTY_INSIGHTS_MESSAGE = 'Apply to more positions to see patterns.';
export const MIN_RECORDED_OUTCOMES = 10;

export interface OutcomeRecord {
  postingId: string;
  companySlug: string;
  companyName: string;
  category: CategoryValue;
  tier: 1 | 2 | 3 | null;
  source: string;
  postedAt: string | null;
  appliedAt: string;
  events: OutcomeEvent[];
}

export interface BreakdownRow {
  key: string;
  label: string;
  applied: number;
  interviewed: number;
  offered: number;
  ghosted: number;
  interviewRate: number;
  offerRate: number;
  ghostRate: number;
}

export interface TimelinePoint {
  weekStart: string;
  applications: number;
  interviews: number;
}

export interface OutcomeStats {
  applicationsSent: number;
  interviewed: number;
  offers: number;
  interviewRate: number;
  offerRate: number;
  averageResponseDays: number | null;
  byCategory: BreakdownRow[];
  byTier: BreakdownRow[];
  timeline: TimelinePoint[];
}

export type RecalibrationAdjustment =
  | { kind: 'target_category'; category: CategoryValue }
  | { kind: 'tier_bonus'; tier: 1 | 2 | 3; points: number }
  | { kind: 'freshness_bonus'; maxDays: number; points: number };

export interface RecalibrationSuggestion {
  id: string;
  message: string;
  adjustment: RecalibrationAdjustment;
}

export interface OutcomeAnalysis {
  ready: boolean;
  recordedOutcomeCount: number;
  message: string;
  suggestions: RecalibrationSuggestion[];
  observations: string[];
  stats: OutcomeStats;
}

function roundRate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function hasInterview(record: OutcomeRecord): boolean {
  return record.events.some((event) => (
    event.outcome === 'interview'
    || event.outcome === 'offer'
    || event.interviewRounds > 0
  ));
}

function hasOffer(record: OutcomeRecord): boolean {
  return record.events.some((event) => event.outcome === 'offer');
}

function latestOutcome(record: OutcomeRecord): ApplicationOutcome | null {
  return record.events.at(-1)?.outcome ?? null;
}

function firstResponseAt(record: OutcomeRecord): string | null {
  return record.events.find((event) => (
    event.outcome !== 'ghosted' && event.outcome !== 'withdrawn'
  ))?.occurredAt ?? null;
}

function responseDaysForRecord(record: OutcomeRecord): number | null {
  const responseAt = firstResponseAt(record);
  if (!responseAt) return null;
  const duration = new Date(responseAt).getTime() - new Date(record.appliedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return null;
  return duration / 86_400_000;
}

function categoryLabel(category: string): string {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.shortLabel ?? category;
}

function makeBreakdown(
  records: readonly OutcomeRecord[],
  keyFor: (record: OutcomeRecord) => string,
  labelFor: (key: string) => string,
): BreakdownRow[] {
  const groups = new Map<string, OutcomeRecord[]>();
  for (const record of records) {
    const key = keyFor(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  return Array.from(groups, ([key, group]) => {
    const interviewed = group.filter(hasInterview).length;
    const offered = group.filter(hasOffer).length;
    const ghosted = group.filter((record) => latestOutcome(record) === 'ghosted').length;
    return {
      key,
      label: labelFor(key),
      applied: group.length,
      interviewed,
      offered,
      ghosted,
      interviewRate: roundRate(interviewed, group.length),
      offerRate: roundRate(offered, group.length),
      ghostRate: roundRate(ghosted, group.length),
    };
  }).sort((left, right) => right.applied - left.applied || left.label.localeCompare(right.label));
}

function utcWeekStart(iso: string): string {
  const date = new Date(iso);
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - offset);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

export function calculateOutcomeStats(records: readonly OutcomeRecord[]): OutcomeStats {
  const applicationsSent = records.length;
  const interviewed = records.filter(hasInterview).length;
  const offers = records.filter(hasOffer).length;
  const responseDays = records.flatMap((record) => {
    const days = responseDaysForRecord(record);
    return days === null ? [] : [days];
  });

  const timelineMap = new Map<string, TimelinePoint>();
  for (const record of records) {
    const applicationWeek = utcWeekStart(record.appliedAt);
    const applicationPoint = timelineMap.get(applicationWeek)
      ?? { weekStart: applicationWeek, applications: 0, interviews: 0 };
    applicationPoint.applications += 1;
    timelineMap.set(applicationWeek, applicationPoint);

    const firstInterview = record.events.find((event) => (
      event.outcome === 'interview' || event.outcome === 'offer' || event.interviewRounds > 0
    ));
    if (firstInterview) {
      const interviewWeek = utcWeekStart(firstInterview.occurredAt);
      const interviewPoint = timelineMap.get(interviewWeek)
        ?? { weekStart: interviewWeek, applications: 0, interviews: 0 };
      interviewPoint.interviews += 1;
      timelineMap.set(interviewWeek, interviewPoint);
    }
  }

  return {
    applicationsSent,
    interviewed,
    offers,
    interviewRate: roundRate(interviewed, applicationsSent),
    offerRate: roundRate(offers, applicationsSent),
    averageResponseDays: responseDays.length > 0
      ? Math.round((responseDays.reduce((sum, days) => sum + days, 0) / responseDays.length) * 10) / 10
      : null,
    byCategory: makeBreakdown(records, (record) => record.category, categoryLabel),
    byTier: makeBreakdown(
      records,
      (record) => record.tier === null ? 'unranked' : String(record.tier),
      (key) => key === 'unranked' ? 'Unranked' : `Tier ${key}`,
    ),
    timeline: Array.from(timelineMap.values()).sort((left, right) => left.weekStart.localeCompare(right.weekStart)),
  };
}

function rankedDifference(rows: readonly BreakdownRow[]): [BreakdownRow, BreakdownRow] | null {
  const eligible = rows.filter((row) => row.applied >= 3)
    .sort((left, right) => right.interviewRate - left.interviewRate);
  const first = eligible[0];
  const second = eligible[1];
  if (!first || !second || first.interviewRate - second.interviewRate < 15) return null;
  return [first, second];
}

function timingSuggestion(records: readonly OutcomeRecord[]): RecalibrationSuggestion | null {
  const withTiming = records.filter((record) => record.postedAt !== null);
  const early = withTiming.filter((record) => {
    const elapsed = new Date(record.appliedAt).getTime() - new Date(record.postedAt!).getTime();
    return elapsed >= 0 && elapsed <= 3 * 86_400_000;
  });
  const later = withTiming.filter((record) => !early.includes(record));
  if (early.length < 3 || later.length < 3) return null;
  const earlyRate = roundRate(early.filter(hasInterview).length, early.length);
  const laterRate = roundRate(later.filter(hasInterview).length, later.length);
  if (earlyRate - laterRate < 15) return null;
  return {
    id: 'freshness:3',
    message: `Pattern in your history (${String(withTiming.length)} applications): applications sent within 3 days had a ${String(earlyRate)}% interview rate versus ${String(laterRate)}% later. Small sample—an early trend, not a guarantee. Apply to add a visible +5 freshness adjustment.`,
    adjustment: { kind: 'freshness_bonus', maxDays: 3, points: 5 },
  };
}

export function analyzeOutcomeHistory(records: readonly OutcomeRecord[]): OutcomeAnalysis {
  const stats = calculateOutcomeStats(records);
  const recordedOutcomeCount = records.filter((record) => record.events.length > 0).length;
  if (records.length === 0) {
    return {
      ready: false,
      recordedOutcomeCount: 0,
      message: EMPTY_INSIGHTS_MESSAGE,
      suggestions: [],
      observations: [],
      stats,
    };
  }
  if (recordedOutcomeCount < MIN_RECORDED_OUTCOMES) {
    return {
      ready: false,
      recordedOutcomeCount,
      message: `${String(recordedOutcomeCount)} recorded outcomes. Insights unlock at ${String(MIN_RECORDED_OUTCOMES)}; patterns can change as your history grows.`,
      suggestions: [],
      observations: [],
      stats,
    };
  }

  const suggestions: RecalibrationSuggestion[] = [];
  const categoryDifference = rankedDifference(stats.byCategory);
  if (categoryDifference) {
    const [best, comparison] = categoryDifference;
    const category = normalizeCategoryValue(best.key);
    if (category) {
      suggestions.push({
        id: `category:${category}`,
        message: `Pattern in your history (${String(stats.applicationsSent)} applications): ${best.label} reached interviews ${String(best.interviewRate)}% of the time versus ${String(comparison.interviewRate)}% for ${comparison.label}. Small sample—consider broadening this target, not treating it as a guarantee.`,
        adjustment: { kind: 'target_category', category },
      });
    }
  }

  const tierDifference = rankedDifference(stats.byTier.filter((row) => row.key !== 'unranked'));
  if (tierDifference) {
    const [best, comparison] = tierDifference;
    const tier = Number(best.key) as 1 | 2 | 3;
    suggestions.push({
      id: `tier:${best.key}`,
      message: `Pattern in your history (${String(stats.applicationsSent)} applications): ${best.label} reached interviews ${String(best.interviewRate)}% of the time versus ${String(comparison.interviewRate)}% for ${comparison.label}. Small sample—apply only if you want an explicit +5 ${best.label} scoring adjustment.`,
      adjustment: { kind: 'tier_bonus', tier, points: 5 },
    });
  }

  const earlySuggestion = timingSuggestion(records);
  if (earlySuggestion) suggestions.push(earlySuggestion);

  const observations: string[] = [];
  const sources = makeBreakdown(records, (record) => record.source || 'unknown', (key) => key);
  if (sources.length > 1) {
    const best = [...sources].sort((left, right) => right.interviewRate - left.interviewRate)[0];
    if (best) {
      observations.push(`Pattern in your history (${String(best.applied)} applications hosted through ${best.label}): the interview rate was ${String(best.interviewRate)}%. This describes your employer mix and does not measure ATS quality.`);
    }
  }

  const companyResponses = new Map<string, { name: string; days: number[] }>();
  for (const record of records) {
    const days = responseDaysForRecord(record);
    if (days === null) continue;
    const key = record.companySlug || record.companyName;
    const group = companyResponses.get(key) ?? { name: record.companyName, days: [] };
    group.days.push(days);
    companyResponses.set(key, group);
  }
  const responsiveCompany = Array.from(companyResponses.values())
    .filter((group) => group.days.length >= 2)
    .map((group) => ({
      ...group,
      average: group.days.reduce((sum, days) => sum + days, 0) / group.days.length,
    }))
    .sort((left, right) => left.average - right.average)[0];
  if (responsiveCompany) {
    const average = Math.round(responsiveCompany.average * 10) / 10;
    observations.push(`Pattern in your history (${String(responsiveCompany.days.length)} applications with recorded responses): ${responsiveCompany.name} had your fastest company-level average response at ${String(average)} day${average === 1 ? '' : 's'}. Small sample; response times can vary by role.`);
  }

  const tierGhostRates = stats.byTier
    .filter((row) => row.key !== 'unranked' && row.applied >= 3)
    .sort((left, right) => right.ghostRate - left.ghostRate);
  const highestGhostTier = tierGhostRates[0];
  const comparisonGhostTier = tierGhostRates[1];
  if (highestGhostTier && comparisonGhostTier && highestGhostTier.ghostRate > comparisonGhostTier.ghostRate) {
    observations.push(`Pattern in your history: ${highestGhostTier.label} had a ${String(highestGhostTier.ghostRate)}% ghost rate (${String(highestGhostTier.ghosted)} of ${String(highestGhostTier.applied)} applications), versus ${String(comparisonGhostTier.ghostRate)}% for ${comparisonGhostTier.label} (${String(comparisonGhostTier.applied)} applications). This is descriptive and may change with more outcomes.`);
  }

  const allRejected = records.every((record) => latestOutcome(record) === 'rejection');
  return {
    ready: true,
    recordedOutcomeCount,
    message: allRejected
      ? 'No interview pattern has emerged yet. Patterns can change as you add more applications; this history is descriptive, not a judgment of your prospects.'
      : 'These are patterns in your history, not causal conclusions. Sample sizes are shown so you can decide what—if anything—to adjust.',
    suggestions,
    observations,
    stats,
  };
}

interface OutcomeQueryRow {
  posting_id: string;
  applied_at: string;
  data: string;
  category: string | null;
}

interface EventQueryRow {
  posting_id: string;
  outcome: ApplicationOutcome;
  occurred_at: string;
  interview_rounds: number;
  notes: string | null;
}

export async function loadOutcomeRecords(
  db: Database,
  profile: Profile,
): Promise<OutcomeRecord[]> {
  const rows = await db.query<OutcomeQueryRow>(
    `SELECT a.posting_id, a.applied_at, p.data, p.category
     FROM applications a
     INNER JOIN postings_cache p ON p.id = a.posting_id
     WHERE a.applied_at IS NOT NULL
     ORDER BY a.applied_at`,
  );
  const events = await db.query<EventQueryRow>(
    `SELECT posting_id, outcome, occurred_at, interview_rounds, notes
     FROM application_outcome_events
     ORDER BY occurred_at, id`,
  );
  const eventsByPosting = new Map<string, OutcomeEvent[]>();
  for (const event of events) {
    const list = eventsByPosting.get(event.posting_id) ?? [];
    list.push({
      outcome: event.outcome,
      occurredAt: event.occurred_at,
      interviewRounds: event.interview_rounds,
      notes: event.notes,
    });
    eventsByPosting.set(event.posting_id, list);
  }

  return rows.map((row) => {
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.data);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep safe fallbacks for malformed cached data.
    }
    const companySlug = typeof data['company_slug'] === 'string' ? data['company_slug'] : '';
    return {
      postingId: row.posting_id,
      companySlug,
      companyName: typeof data['company'] === 'string' ? data['company'] : companySlug || 'Unknown company',
      category: normalizeCategoryValue(row.category) ?? 'other',
      tier: profile.tiers[companySlug] ?? null,
      source: typeof data['ats'] === 'string'
        ? data['ats']
        : typeof data['source'] === 'string' ? data['source'] : 'unknown',
      postedAt: typeof data['posted_at'] === 'string' ? data['posted_at'] : null,
      appliedAt: row.applied_at,
      events: eventsByPosting.get(row.posting_id) ?? [],
    };
  });
}

export function applySuggestionToProfile(
  profile: Profile,
  suggestion: RecalibrationSuggestion,
): Profile {
  const adjustment = suggestion.adjustment;
  if (adjustment.kind === 'target_category') {
    return profile.target_categories.includes(adjustment.category)
      ? profile
      : { ...profile, target_categories: [...profile.target_categories, adjustment.category] };
  }
  if (adjustment.kind === 'tier_bonus') {
    return {
      ...profile,
      scoring_adjustments: {
        ...profile.scoring_adjustments,
        tier_bonus: {
          ...profile.scoring_adjustments?.tier_bonus,
          [String(adjustment.tier)]: adjustment.points,
        },
      },
    };
  }
  return {
    ...profile,
    scoring_adjustments: {
      ...profile.scoring_adjustments,
      freshness_bonus: {
        max_days: adjustment.maxDays,
        points: adjustment.points,
      },
    },
  };
}
