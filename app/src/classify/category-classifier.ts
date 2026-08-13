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

export function classifyCategory(
  title: string,
  description: string | null,
): CategoryResult {
  const titleMatch = matchCategory(title, 'title');
  if (titleMatch) return titleMatch;

  if (description) {
    const descMatch = matchCategory(description, 'description');
    if (descMatch) return descMatch;
  }

  return {
    category: 'other',
    matched_rule: null,
    matched_in: null,
  };
}
