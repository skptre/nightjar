import type { Profile } from '@/profile/types';
import type { EligibilityVerdict, CategoryValue } from './types';

export interface ScoreBreakdown {
  tier: number;
  freshness: number;
  category: number;
  eligibility: number;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
}

export interface ScoringInput {
  company_slug: string;
  first_seen_at: string;
  eligibility_verdict: EligibilityVerdict;
  category: CategoryValue;
}

const FRESHNESS_DECAY_RATE = 0.05;
const FRESHNESS_MAX = 30;
const FRESHNESS_MIN = 2;

function computeTierScore(companySlug: string, profile: Profile): number {
  const tier = profile.tiers[companySlug];
  if (tier === undefined) return 15;
  if (tier === 1) return 30;
  if (tier === 2) return 20;
  return 10;
}

function computeFreshnessScore(firstSeenAt: string, now: Date): number {
  const seenDate = new Date(firstSeenAt);
  const diffMs = now.getTime() - seenDate.getTime();
  const daysOld = Math.max(0, diffMs / (1000 * 60 * 60 * 24));
  const raw = FRESHNESS_MAX * Math.exp(-FRESHNESS_DECAY_RATE * daysOld);
  return Math.max(FRESHNESS_MIN, Math.min(FRESHNESS_MAX, Math.round(raw * 100) / 100));
}

function computeCategoryScore(
  category: CategoryValue,
  targetCategories: string[],
): number {
  if (targetCategories.includes(category)) return 20;
  if (category === 'other') return 10;
  return 5;
}

function computeEligibilityScore(verdict: EligibilityVerdict): number {
  if (verdict === 'eligible') return 20;
  if (verdict === 'unclear') return 15;
  return 0;
}

export function scorePosting(
  input: ScoringInput,
  profile: Profile,
  now?: Date,
): ScoreResult {
  const currentTime = now ?? new Date();

  const tier = computeTierScore(input.company_slug, profile);
  const freshness = computeFreshnessScore(input.first_seen_at, currentTime);
  const category = computeCategoryScore(input.category, profile.target_categories);
  const eligibility = computeEligibilityScore(input.eligibility_verdict);

  const breakdown: ScoreBreakdown = { tier, freshness, category, eligibility };

  if (input.eligibility_verdict === 'ineligible') {
    return { score: Math.min(5, tier + freshness + category), breakdown };
  }

  const total = tier + freshness + category + eligibility;
  return { score: Math.min(100, Math.round(total * 100) / 100), breakdown };
}
