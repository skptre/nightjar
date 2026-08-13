import type { EligibilityResult, EligibilityFlag, ClassificationRules } from './types';
import type { Profile } from '@/profile/types';
import rules from './rules.json';

const typedRules = rules as ClassificationRules;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?:\n)+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function findMatchingSentence(text: string, regex: RegExp): string | null {
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (regex.test(sentence)) {
      return sentence.length > 300 ? sentence.substring(0, 300) + '...' : sentence;
    }
  }

  const wholeMatch = regex.exec(text);
  if (wholeMatch) {
    const start = Math.max(0, wholeMatch.index - 50);
    const end = Math.min(text.length, wholeMatch.index + wholeMatch[0].length + 50);
    return text.substring(start, end).trim();
  }

  return null;
}

function checkSponsorship(
  description: string,
  profile: Profile,
): EligibilityFlag[] {
  if (!profile.requires_sponsorship) return [];

  const flags: EligibilityFlag[] = [];
  const lower = description.toLowerCase();

  for (const entry of typedRules.sponsorship_patterns) {
    const regex = new RegExp(entry.pattern, 'i');
    if (regex.test(lower)) {
      const sentence = findMatchingSentence(description, regex);
      if (sentence) {
        flags.push({
          type: entry.flag_type as EligibilityFlag['type'],
          matched_sentence: sentence,
          pattern: entry.pattern,
        });
      }
    }
  }

  return flags;
}

function parseYearFromText(text: string, patterns: string[]): number[] {
  const years: number[] = [];
  for (const pat of patterns) {
    const regex = new RegExp(pat, 'gi');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      for (let i = 1; i < match.length; i++) {
        const val = match[i];
        if (val && /^\d{4}$/.test(val)) {
          years.push(parseInt(val, 10));
        }
      }
    }
  }
  return years;
}

function checkGradWindow(
  description: string,
  profile: Profile,
): EligibilityFlag[] {
  const flags: EligibilityFlag[] = [];
  const years = parseYearFromText(description.toLowerCase(), typedRules.grad_window_patterns);

  if (years.length === 0) return [];

  const gradParts = profile.graduation.split('-');
  if (gradParts.length < 2 || !gradParts[0] || !gradParts[1]) return [];
  const userGradYear = parseInt(gradParts[0], 10);

  const [windowStart, windowEnd] = profile.grad_window;
  if (!windowStart || !windowEnd) return [];
  const windowStartYear = parseInt(windowStart.split('-')[0] ?? '0', 10);
  const windowEndYear = parseInt(windowEnd.split('-')[0] ?? '9999', 10);

  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  if (userGradYear < minYear || userGradYear > maxYear) {
    if (windowEndYear < minYear || windowStartYear > maxYear) {
      for (const pat of typedRules.grad_window_patterns) {
        const regex = new RegExp(pat, 'i');
        const sentence = findMatchingSentence(description, regex);
        if (sentence) {
          flags.push({
            type: 'grad_window_mismatch',
            matched_sentence: sentence,
            pattern: pat,
          });
          break;
        }
      }
    }
  }

  return flags;
}

function checkClassYear(
  description: string,
  profile: Profile,
): EligibilityFlag[] {
  const flags: EligibilityFlag[] = [];
  const lower = description.toLowerCase();

  for (const entry of typedRules.class_year_patterns) {
    const regex = new RegExp(entry.pattern, 'i');
    if (regex.test(lower)) {
      if (entry.class_year !== profile.current_class_year) {
        const sentence = findMatchingSentence(description, regex);
        if (sentence) {
          flags.push({
            type: 'class_year_mismatch',
            matched_sentence: sentence,
            pattern: entry.pattern,
          });
        }
      }
    }
  }

  return flags;
}

function checkLocation(
  postingLocations: string[],
  profile: Profile,
): EligibilityFlag[] {
  if (profile.locations.length === 0) return [];

  const userLocationsLower = profile.locations.map((l) => l.toLowerCase());
  if (userLocationsLower.includes('us') || userLocationsLower.includes('united states') || userLocationsLower.includes('any')) {
    return [];
  }

  if (postingLocations.length === 0) return [];

  const hasMatchingLocation = postingLocations.some((loc) => {
    const lower = loc.toLowerCase();
    return userLocationsLower.some((ul) => lower.includes(ul));
  });

  if (!hasMatchingLocation) {
    const allNonUS = postingLocations.every((loc) => {
      const lower = loc.toLowerCase();
      const usIndicators = [
        'united states', 'usa', 'u.s.', 'us,',
        ', al', ', ak', ', az', ', ar', ', ca', ', co', ', ct', ', de', ', fl', ', ga',
        ', hi', ', id', ', il', ', in', ', ia', ', ks', ', ky', ', la', ', me', ', md',
        ', ma', ', mi', ', mn', ', ms', ', mo', ', mt', ', ne', ', nv', ', nh', ', nj',
        ', nm', ', ny', ', nc', ', nd', ', oh', ', ok', ', or', ', pa', ', ri', ', sc',
        ', sd', ', tn', ', tx', ', ut', ', vt', ', va', ', wa', ', wv', ', wi', ', wy',
        ', dc', 'new york', 'san francisco', 'los angeles', 'chicago', 'seattle',
        'austin', 'boston', 'denver', 'atlanta', 'miami', 'houston', 'dallas',
        'philadelphia', 'phoenix', 'san diego', 'san jose', 'minneapolis',
        'remote',
      ];
      return !usIndicators.some((ind) => lower.includes(ind));
    });

    if (allNonUS) {
      return [{
        type: 'location_mismatch' as const,
        matched_sentence: `Location: ${postingLocations.join(', ')}`,
        pattern: 'non-US location',
      }];
    }
  }

  return [];
}

export function checkEligibility(
  title: string,
  description: string | null,
  postingLocations: string[],
  profile: Profile,
): EligibilityResult {
  const allFlags: EligibilityFlag[] = [];

  if (description) {
    const sponsorshipFlags = checkSponsorship(description, profile);
    allFlags.push(...sponsorshipFlags);

    const gradFlags = checkGradWindow(description, profile);
    allFlags.push(...gradFlags);

    const classFlags = checkClassYear(description, profile);
    allFlags.push(...classFlags);
  }

  const locationFlags = checkLocation(postingLocations, profile);
  allFlags.push(...locationFlags);

  if (allFlags.length === 0) {
    return {
      verdict: 'unclear',
      reasons: [],
      flags: [],
    };
  }

  const reasons = allFlags.map((flag) => `matched: '${flag.matched_sentence}'`);

  return {
    verdict: 'ineligible',
    reasons,
    flags: allFlags,
  };
}
