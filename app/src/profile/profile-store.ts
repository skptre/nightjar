import type { Profile } from './types';

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
    ? raw['target_categories']
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

  return {
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
