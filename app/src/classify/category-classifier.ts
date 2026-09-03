import type {
  CategoryResult,
  CategoryValue,
  ClassificationRules,
} from './types';
import { normalizeCategoryValue } from './types';
import rules from './rules.json';

const typedRules = rules as ClassificationRules;
const MAX_CATEGORY_TAGS = 3;

interface CategoryMatch {
  category: CategoryValue;
  keyword: string;
  source: 'title' | 'description' | null;
  priority: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(text: string, keyword: string): boolean {
  const phrase = escapeRegex(keyword).replace(/\s+/g, '\\s+');
  const regex = new RegExp(`(?:^|[^a-z0-9])${phrase}(?=$|[^a-z0-9])`, 'i');
  return regex.test(text);
}

function findMatches(
  text: string,
  source: 'title' | 'description',
): CategoryMatch[] {
  const matches: CategoryMatch[] = [];

  for (const rule of typedRules.category_rules) {
    const keyword = rule.keywords.find((candidate) => keywordMatches(text, candidate));
    if (keyword) {
      matches.push({
        category: rule.category,
        keyword,
        source,
        priority: rule.priority,
      });
    }
  }

  return matches.sort((left, right) => right.priority - left.priority);
}

function mapSimplifyCategory(simplifyCategory: string): CategoryMatch | null {
  const mapped = normalizeCategoryValue(typedRules.simplify_category_map[simplifyCategory]);
  if (!mapped || mapped === 'other') return null;
  return {
    category: mapped,
    keyword: `simplify:${simplifyCategory}`,
    source: null,
    priority: -1,
  };
}

function uniqueTags(matches: readonly CategoryMatch[]): CategoryValue[] {
  const tags: CategoryValue[] = [];
  for (const match of matches) {
    if (!tags.includes(match.category)) tags.push(match.category);
    if (tags.length === MAX_CATEGORY_TAGS) break;
  }
  return tags;
}

export function classifyCategory(
  title: string,
  description: string | null,
  simplifyCategory?: string,
): CategoryResult {
  const titleMatches = findMatches(title, 'title');
  const descriptionMatches = description
    ? findMatches(description, 'description')
    : [];
  const simplifyMatch = simplifyCategory
    ? mapSimplifyCategory(simplifyCategory)
    : null;

  // [NJ] Title evidence always controls the primary category when present.
  const primary = titleMatches[0] ?? descriptionMatches[0] ?? simplifyMatch;
  if (!primary) {
    return {
      category: 'other',
      category_tags: ['other'],
      matched_rule: null,
      matched_in: null,
    };
  }

  const allMatches = [
    ...titleMatches,
    ...descriptionMatches,
    ...(simplifyMatch ? [simplifyMatch] : []),
  ];

  return {
    category: primary.category,
    category_tags: uniqueTags(allMatches),
    matched_rule: primary.keyword,
    matched_in: primary.source,
  };
}
