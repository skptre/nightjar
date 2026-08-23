export type Term =
  | 'summer_2025' | 'fall_2025' | 'winter_2025' | 'spring_2025'
  | 'summer_2026' | 'fall_2026' | 'winter_2026' | 'spring_2026'
  | 'summer_2027' | 'fall_2027' | 'winter_2027' | 'spring_2027'
  | 'summer_2028' | 'fall_2028' | 'winter_2028' | 'spring_2028'
  | 'summer_2029' | 'fall_2029' | 'winter_2029' | 'spring_2029'
  | 'new_grad'
  | 'co_op'
  | 'year_round'
  | 'unknown';

export type TermConfidence = 'explicit' | 'inferred';

export interface TermResult {
  term: Term;
  confidence: TermConfidence;
  matched: string | null;
}

export type CategoryValue = 'swe' | 'quant' | 'ml' | 'hardware' | 'other';

export interface CategoryResult {
  category: CategoryValue;
  matched_rule: string | null;
  matched_in: 'title' | 'description' | null;
}

export type EligibilityVerdict = 'eligible' | 'ineligible' | 'unclear';

export type EligibilityFlagType =
  | 'no_sponsorship'
  | 'clearance_required'
  | 'citizenship_required'
  | 'grad_window_mismatch'
  | 'class_year_mismatch'
  | 'location_mismatch'
  | 'itar_ear'
  | 'eligible_sponsorship';

export const HARD_BLOCK_TYPES: ReadonlySet<EligibilityFlagType> = new Set([
  'citizenship_required',
  'clearance_required',
  'itar_ear',
]);

export interface EligibilityFlag {
  type: EligibilityFlagType;
  matched_sentence: string;
  pattern: string;
}

export interface EligibilityResult {
  verdict: EligibilityVerdict;
  reasons: string[];
  flags: EligibilityFlag[];
}

export interface ClassificationResult {
  term: TermResult;
  category: CategoryResult;
  eligibility: EligibilityResult;
}

export interface TermPattern {
  pattern: string;
  season: string;
  year_group?: number;
}

export interface CategoryRule {
  keywords: string[];
  category: CategoryValue;
}

export interface SponsorshipPattern {
  pattern: string;
  flag_type: EligibilityFlagType;
}

export interface EligibleSponsorshipPattern {
  pattern: string;
}

export interface ClassificationRules {
  term_patterns: TermPattern[];
  new_grad_patterns: string[];
  co_op_patterns: string[];
  year_round_patterns: string[];
  category_rules: CategoryRule[];
  simplify_category_map: Record<string, CategoryValue>;
  sponsorship_patterns: SponsorshipPattern[];
  eligible_sponsorship_patterns: EligibleSponsorshipPattern[];
  grad_window_patterns: string[];
  class_year_patterns: Array<{
    pattern: string;
    class_year: string;
  }>;
}
