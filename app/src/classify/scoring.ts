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
  category_tags: readonly CategoryValue[];
}

const FRESHNESS_DECAY_RATE = 0.05;
const FRESHNESS_MAX = 30;
const FRESHNESS_MIN = 2;

function computeTierScore(companySlug: string, profile: Profile): number {
  const tier = profile.tiers[companySlug];
  if (tier === undefined) return 15;
  const base = tier === 1 ? 30 : tier === 2 ? 20 : 10;
  const bonus = profile.scoring_adjustments?.tier_bonus?.[String(tier) as '1' | '2' | '3'] ?? 0;
  return Math.max(0, Math.min(40, base + bonus));
}

function computeFreshnessScore(firstSeenAt: string, now: Date, profile: Profile): number {
  const seenDate = new Date(firstSeenAt);
  const diffMs = now.getTime() - seenDate.getTime();
  const daysOld = Math.max(0, diffMs / (1000 * 60 * 60 * 24));
  const raw = FRESHNESS_MAX * Math.exp(-FRESHNESS_DECAY_RATE * daysOld);
  const base = Math.max(FRESHNESS_MIN, Math.min(FRESHNESS_MAX, Math.round(raw * 100) / 100));
  const adjustment = profile.scoring_adjustments?.freshness_bonus;
  const bonus = adjustment && daysOld <= adjustment.max_days ? adjustment.points : 0;
  return Math.max(0, Math.min(40, Math.round((base + bonus) * 100) / 100));
}

function computeCategoryScore(
  category: CategoryValue,
  categoryTags: readonly CategoryValue[],
  targetCategories: string[],
): number {
  const matchableCategories = categoryTags.length > 0 ? categoryTags : [category];
  if (matchableCategories.some((tag) => targetCategories.includes(tag))) return 20;
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
  const freshness = computeFreshnessScore(input.first_seen_at, currentTime, profile);
  const category = computeCategoryScore(
    input.category,
    input.category_tags,
    profile.target_categories,
  );
  const eligibility = computeEligibilityScore(input.eligibility_verdict);

  const breakdown: ScoreBreakdown = { tier, freshness, category, eligibility };

  if (input.eligibility_verdict === 'ineligible') {
    return { score: Math.min(5, tier + freshness + category), breakdown };
  }

  const total = tier + freshness + category + eligibility;
  return { score: Math.min(100, Math.round(total * 100) / 100), breakdown };
}
