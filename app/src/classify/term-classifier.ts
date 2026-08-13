import type { Term, TermResult, TermPattern, ClassificationRules } from './types';
import rules from './rules.json';

const typedRules = rules as ClassificationRules;

function expandShortYear(captured: string): string {
  if (captured.length === 2) {
    return `20${captured}`;
  }
  return captured;
}

function buildTerm(season: string, year: string): Term {
  const fullYear = expandShortYear(year);
  const candidate = `${season}_${fullYear}`;
  return candidate as Term;
}

function matchTermPatterns(text: string, patterns: TermPattern[]): TermResult | null {
  const lower = text.toLowerCase();
  for (const entry of patterns) {
    const regex = new RegExp(entry.pattern, 'i');
    const match = regex.exec(lower);
    if (match) {
      const yearGroup = entry.year_group ?? 1;
      const captured = match[yearGroup];
      if (!captured) continue;
      const term = buildTerm(entry.season, captured);
      return {
        term,
        confidence: 'explicit',
        matched: match[0],
      };
    }
  }
  return null;
}

function matchNewGradPatterns(text: string, patterns: string[]): TermResult | null {
  const lower = text.toLowerCase();
  for (const pat of patterns) {
    const regex = new RegExp(pat, 'i');
    const match = regex.exec(lower);
    if (match) {
      return {
        term: 'new_grad',
        confidence: 'explicit',
        matched: match[0],
      };
    }
  }
  return null;
}

function matchYearRoundPatterns(text: string, patterns: string[]): TermResult | null {
  const lower = text.toLowerCase();
  for (const pat of patterns) {
    const regex = new RegExp(pat, 'i');
    const match = regex.exec(lower);
    if (match) {
      return {
        term: 'year_round',
        confidence: 'explicit',
        matched: match[0],
      };
    }
  }
  return null;
}

function inferSeasonFromMonth(month: number): string {
  if (month >= 5 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'fall';
  if (month >= 1 && month <= 2) return 'winter';
  if (month >= 3 && month <= 4) return 'spring';
  return 'winter';
}

function inferFromPostedDate(postedAt: string | null): TermResult | null {
  if (!postedAt) return null;

  const date = new Date(postedAt);
  if (isNaN(date.getTime())) return null;

  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();

  let targetYear: number;
  let targetSeason: string;

  if (month >= 8 && month <= 12) {
    targetSeason = 'summer';
    targetYear = year + 1;
  } else if (month >= 1 && month <= 4) {
    targetSeason = 'summer';
    targetYear = year;
  } else {
    targetSeason = inferSeasonFromMonth(month);
    targetYear = year;
  }

  const term = `${targetSeason}_${String(targetYear)}` as Term;
  return {
    term,
    confidence: 'inferred',
    matched: null,
  };
}

export function classifyTerm(
  title: string,
  description: string | null,
  postedAt: string | null,
): TermResult {
  const titleResult = matchTermPatterns(title, typedRules.term_patterns);
  if (titleResult) return titleResult;

  const titleNewGrad = matchNewGradPatterns(title, typedRules.new_grad_patterns);
  if (titleNewGrad) return titleNewGrad;

  const titleYearRound = matchYearRoundPatterns(title, typedRules.year_round_patterns);
  if (titleYearRound) return titleYearRound;

  if (description) {
    const descResult = matchTermPatterns(description, typedRules.term_patterns);
    if (descResult) return descResult;

    const descNewGrad = matchNewGradPatterns(description, typedRules.new_grad_patterns);
    if (descNewGrad) return descNewGrad;

    const descYearRound = matchYearRoundPatterns(description, typedRules.year_round_patterns);
    if (descYearRound) return descYearRound;
  }

  const inferred = inferFromPostedDate(postedAt);
  if (inferred) return inferred;

  return {
    term: 'unknown',
    confidence: 'inferred',
    matched: null,
  };
}
