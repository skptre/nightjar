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

export const CATEGORY_VALUES = [
  'swe',
  'data-ml',
  'quant',
  'hardware',
  'mechE',
  'ECE',
  'aero',
  'civil',
  'chemE',
  'bioE',
  'finance',
  'accounting',
  'consulting',
  'research',
  'design',
  'operations',
  'supply-chain',
  'other',
] as const;

export type CategoryValue = (typeof CATEGORY_VALUES)[number];

export interface CategoryOption {
  value: CategoryValue;
  label: string;
  shortLabel: string;
}

export interface CategoryGroup {
  label: 'Engineering' | 'Business' | 'Other';
  options: readonly CategoryOption[];
}

export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  {
    label: 'Engineering',
    options: [
      { value: 'swe', label: 'Software Engineering', shortLabel: 'SWE' },
      { value: 'data-ml', label: 'Data / Machine Learning', shortLabel: 'Data/ML' },
      { value: 'hardware', label: 'Hardware / Embedded', shortLabel: 'Hardware' },
      { value: 'mechE', label: 'Mechanical Engineering', shortLabel: 'MechE' },
      { value: 'ECE', label: 'Electrical & Computer Engineering', shortLabel: 'ECE' },
      { value: 'aero', label: 'Aerospace Engineering', shortLabel: 'Aero' },
      { value: 'civil', label: 'Civil Engineering', shortLabel: 'Civil' },
      { value: 'chemE', label: 'Chemical Engineering', shortLabel: 'ChemE' },
      { value: 'bioE', label: 'Biomedical Engineering', shortLabel: 'BioE' },
    ],
  },
  {
    label: 'Business',
    options: [
      { value: 'quant', label: 'Quantitative Finance', shortLabel: 'Quant' },
      { value: 'finance', label: 'Finance', shortLabel: 'Finance' },
      { value: 'accounting', label: 'Accounting', shortLabel: 'Accounting' },
      { value: 'consulting', label: 'Consulting', shortLabel: 'Consulting' },
    ],
  },
  {
    label: 'Other',
    options: [
      { value: 'research', label: 'Research', shortLabel: 'Research' },
      { value: 'design', label: 'Design', shortLabel: 'Design' },
      { value: 'operations', label: 'Operations', shortLabel: 'Operations' },
      { value: 'supply-chain', label: 'Supply Chain', shortLabel: 'Supply Chain' },
    ],
  },
];

export const CATEGORY_FILTER_GROUPS: readonly CategoryGroup[] = CATEGORY_GROUPS.map(
  (group) => group.label === 'Other'
    ? {
        ...group,
        options: [
          ...group.options,
          { value: 'other', label: 'Other', shortLabel: 'Other' },
        ],
      }
    : group,
);

export const CATEGORY_OPTIONS: readonly CategoryOption[] = CATEGORY_FILTER_GROUPS.flatMap(
  (group) => group.options,
);

export function normalizeCategoryValue(value: unknown): CategoryValue | null {
  if (value === 'ml') return 'data-ml';
  if (typeof value !== 'string') return null;
  return (CATEGORY_VALUES as readonly string[]).includes(value)
    ? value as CategoryValue
    : null;
}

export function parseCategoryTags(
  storedTags: string | null | undefined,
  fallbackCategory: string | null | undefined,
): CategoryValue[] {
  let rawTags: unknown[] = [];
  if (storedTags) {
    try {
      const parsed: unknown = JSON.parse(storedTags);
      if (Array.isArray(parsed)) rawTags = parsed;
    } catch {
      // Fall back to the primary category below.
    }
  }

  const normalized = rawTags
    .map(normalizeCategoryValue)
    .filter((value): value is CategoryValue => value !== null && value !== 'other');
  const unique = [...new Set(normalized)].slice(0, 3);
  if (unique.length > 0) return unique;

  return [normalizeCategoryValue(fallbackCategory) ?? 'other'];
}

export function matchesCategorySelection(
  categoryTags: readonly CategoryValue[],
  primaryCategory: string | null | undefined,
  selected: ReadonlySet<string>,
): boolean {
  if (selected.size === 0) return true;
  const tags = categoryTags.length > 0
    ? categoryTags
    : parseCategoryTags(null, primaryCategory);
  return tags.some((tag) => selected.has(tag));
}

export interface CategoryResult {
  category: CategoryValue;
  category_tags: CategoryValue[];
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
  priority: number;
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
