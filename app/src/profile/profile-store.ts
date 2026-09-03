import type { Profile, ScoringAdjustments } from './types';

const STORAGE_KEY = 'nightjar_profile';

const DEFAULT_PROFILE_FIELDS: Pick<Profile, 'locations' | 'excluded_companies' | 'tiers' | 'contacts'> = {
  locations: ['US'],
  excluded_companies: [],
  tiers: {},
  contacts: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isTierRecord(value: unknown): value is Record<string, 1 | 2 | 3> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (v) => v === 1 || v === 2 || v === 3,
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

function isGradWindow(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

function migrateCategoryArray(values: string[]): string[] {
  return [...new Set(values.map((value) => value === 'ml' ? 'data-ml' : value))];
}

function parseScoringAdjustments(value: unknown): ScoringAdjustments | undefined {
  if (!isRecord(value)) return undefined;
  const result: ScoringAdjustments = {};
  if (isRecord(value['tier_bonus'])) {
    const tierBonus: NonNullable<ScoringAdjustments['tier_bonus']> = {};
    for (const tier of ['1', '2', '3'] as const) {
      const points = value['tier_bonus'][tier];
      if (typeof points === 'number' && Number.isFinite(points) && points >= -10 && points <= 10) {
        tierBonus[tier] = points;
      }
    }
    if (Object.keys(tierBonus).length > 0) result.tier_bonus = tierBonus;
  }
  const freshness = value['freshness_bonus'];
  if (
    isRecord(freshness)
    && typeof freshness['max_days'] === 'number'
    && Number.isFinite(freshness['max_days'])
    && freshness['max_days'] >= 0
    && freshness['max_days'] <= 30
    && typeof freshness['points'] === 'number'
    && Number.isFinite(freshness['points'])
    && freshness['points'] >= -10
    && freshness['points'] <= 10
  ) {
    result.freshness_bonus = {
      max_days: freshness['max_days'],
      points: freshness['points'],
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function validateAndRepairProfile(raw: unknown): Profile | null {
  if (!isRecord(raw)) return null;

  if (typeof raw['graduation'] !== 'string' || raw['graduation'] === '') return null;
  if (typeof raw['current_class_year'] !== 'string' || raw['current_class_year'] === '') return null;
  if (typeof raw['work_auth'] !== 'string' || raw['work_auth'] === '') return null;
  if (typeof raw['requires_sponsorship'] !== 'boolean') return null;

  const grad_window = isGradWindow(raw['grad_window'])
    ? raw['grad_window']
    : [raw['graduation'] as string, raw['graduation'] as string] as [string, string];

  const target_categories = isStringArray(raw['target_categories'])
    ? migrateCategoryArray(raw['target_categories'])
    : [];

  const locations = isStringArray(raw['locations'])
    ? raw['locations']
    : DEFAULT_PROFILE_FIELDS.locations;

  const excluded_companies = isStringArray(raw['excluded_companies'])
    ? raw['excluded_companies']
    : DEFAULT_PROFILE_FIELDS.excluded_companies;

  const tiers = isTierRecord(raw['tiers'])
    ? raw['tiers']
    : DEFAULT_PROFILE_FIELDS.tiers;

  const contacts = isStringRecord(raw['contacts'])
    ? raw['contacts']
    : DEFAULT_PROFILE_FIELDS.contacts;

  const result: Profile = {
    graduation: raw['graduation'] as string,
    grad_window,
    current_class_year: raw['current_class_year'] as string,
    work_auth: raw['work_auth'] as string,
    requires_sponsorship: raw['requires_sponsorship'] as boolean,
    target_categories,
    locations,
    excluded_companies,
    tiers,
    contacts,
  };

  if (typeof raw['notifications_enabled'] === 'boolean') {
    result.notifications_enabled = raw['notifications_enabled'];
  }
  if (isStringArray(raw['notification_categories'])) {
    result.notification_categories = migrateCategoryArray(raw['notification_categories']);
  }
  if (typeof raw['notification_min_tier'] === 'number') {
    result.notification_min_tier = raw['notification_min_tier'];
  }
  if (typeof raw['quiet_hours_start'] === 'string') {
    result.quiet_hours_start = raw['quiet_hours_start'];
  }
  if (typeof raw['quiet_hours_end'] === 'string') {
    result.quiet_hours_end = raw['quiet_hours_end'];
  }
  if (typeof raw['sync_interval_ms'] === 'number') {
    result.sync_interval_ms = raw['sync_interval_ms'];
  }
  const scoringAdjustments = parseScoringAdjustments(raw['scoring_adjustments']);
  if (scoringAdjustments) result.scoring_adjustments = scoringAdjustments;

  return result;
}

export function loadProfile(): Profile | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;

    const parsed: unknown = JSON.parse(stored);
    return validateAndRepairProfile(parsed);
  } catch {
    return null;
  }
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

export function clearProfile(): void {
  localStorage.removeItem(STORAGE_KEY);
}
