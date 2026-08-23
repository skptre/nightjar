import type { CategoryResult, CategoryValue, ClassificationRules } from './types';
import rules from './rules.json';

const typedRules = rules as ClassificationRules;

function matchCategory(
  text: string,
  source: 'title' | 'description',
): CategoryResult | null {
  const lower = text.toLowerCase();
  for (const rule of typedRules.category_rules) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword)) {
        return {
          category: rule.category as CategoryValue,
          matched_rule: keyword,
          matched_in: source,
        };
      }
    }
  }
  return null;
}

function mapSimplifyCategory(simplifyCategory: string): CategoryValue | null {
  const map = typedRules.simplify_category_map as Record<string, string>;
  const mapped = map[simplifyCategory];
  if (mapped === 'swe' || mapped === 'quant' || mapped === 'ml' || mapped === 'hardware') {
    return mapped;
  }
  return null;
}

export function classifyCategory(
  title: string,
  description: string | null,
  simplifyCategory?: string,
): CategoryResult {
  const titleMatch = matchCategory(title, 'title');
  if (titleMatch) return titleMatch;

  if (description) {
    const descMatch = matchCategory(description, 'description');
    if (descMatch) return descMatch;
  }

  if (simplifyCategory) {
    const mapped = mapSimplifyCategory(simplifyCategory);
    if (mapped) {
      return {
        category: mapped,
        matched_rule: `simplify:${simplifyCategory}`,
        matched_in: null,
      };
    }
  }

  return {
    category: 'other',
    matched_rule: null,
    matched_in: null,
  };
}
