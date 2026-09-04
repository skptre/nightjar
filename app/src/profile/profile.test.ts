import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadProfile, saveProfile, validateAndRepairProfile, clearProfile } from './profile-store';
import { CATEGORY_GROUPS, computeGradWindow, inferRequiresSponsorship } from './types';
import type { Profile } from './types';

function makeTestProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    graduation: '2029-05',
    grad_window: ['2028-11', '2029-06'],
    current_class_year: 'unknown',
    work_auth: 'f1_opt_cpt',
    requires_sponsorship: true,
    target_categories: ['swe', 'data-ml'],
    locations: ['US'],
    excluded_companies: [],
    tiers: {},
    contacts: {},
    ...overrides,
  };
}

describe('profile-store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('save and load round-trip', () => {
    it('saves and reads back identical profile', () => {
      const profile = makeTestProfile();
      saveProfile(profile);
      const loaded = loadProfile();
      expect(loaded).toEqual(profile);
    });

    it('preserves tiers and contacts', () => {
      const profile = makeTestProfile({
        tiers: { ramp: 2, stripe: 1 },
        contacts: { ramp: 'Warm intro via Sarah' },
      });
      saveProfile(profile);
      const loaded = loadProfile();
      expect(loaded!.tiers).toEqual({ ramp: 2, stripe: 1 });
      expect(loaded!.contacts).toEqual({ ramp: 'Warm intro via Sarah' });
    });

    it('preserves excluded_companies', () => {
      const profile = makeTestProfile({
        excluded_companies: ['boring-corp', 'bad-co'],
      });
      saveProfile(profile);
      const loaded = loadProfile();
      expect(loaded!.excluded_companies).toEqual(['boring-corp', 'bad-co']);
    });
  });

  describe('missing profile', () => {
    it('returns null when no profile exists', () => {
      const loaded = loadProfile();
      expect(loaded).toBeNull();
    });

    it('returns null for empty string in localStorage', () => {
      localStorage.setItem('nightjar_profile', '');
      const loaded = loadProfile();
      expect(loaded).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      localStorage.setItem('nightjar_profile', '{broken json!!!');
      const loaded = loadProfile();
      expect(loaded).toBeNull();
    });
  });

  describe('validation and repair', () => {
    it('maps the retired ml category in profile and notification preferences', () => {
      const result = validateAndRepairProfile({
        ...makeTestProfile(),
        target_categories: ['ml', 'swe', 'ml'],
        notification_categories: ['ml', 'quant'],
      });

      expect(result?.target_categories).toEqual(['data-ml', 'swe']);
      expect(result?.notification_categories).toEqual(['data-ml', 'quant']);
    });

    it('returns null for missing required fields', () => {
      expect(validateAndRepairProfile({})).toBeNull();
      expect(validateAndRepairProfile({ graduation: '2029-05' })).toBeNull();
      expect(
        validateAndRepairProfile({
          graduation: '2029-05',
          current_class_year: 'junior',
        }),
      ).toBeNull();
    });

    it('applies defaults for missing optional fields', () => {
      const minimal = {
        graduation: '2029-05',
        work_auth: 'us_citizen',
        requires_sponsorship: false,
      };
      const result = validateAndRepairProfile(minimal);
      expect(result).not.toBeNull();
      expect(result!.locations).toEqual(['US']);
      expect(result!.excluded_companies).toEqual([]);
      expect(result!.tiers).toEqual({});
      expect(result!.contacts).toEqual({});
      expect(result!.target_categories).toEqual([]);
      expect(result!.current_class_year).toBe('unknown');
    });

    it('repairs invalid grad_window with fallback', () => {
      const withBadWindow = {
        graduation: '2029-05',
        grad_window: 'not an array',
        current_class_year: 'junior',
        work_auth: 'us_citizen',
        requires_sponsorship: false,
      };
      const result = validateAndRepairProfile(withBadWindow);
      expect(result).not.toBeNull();
      expect(result!.grad_window).toEqual(['2029-05', '2029-05']);
    });

    it('repairs invalid tiers by resetting to empty', () => {
      const withBadTiers = {
        graduation: '2029-05',
        current_class_year: 'junior',
        work_auth: 'us_citizen',
        requires_sponsorship: false,
        tiers: { ramp: 5 },
      };
      const result = validateAndRepairProfile(withBadTiers);
      expect(result).not.toBeNull();
      expect(result!.tiers).toEqual({});
    });

    it('preserves valid tiers', () => {
      const withGoodTiers = {
        graduation: '2029-05',
        current_class_year: 'junior',
        work_auth: 'us_citizen',
        requires_sponsorship: false,
        tiers: { ramp: 2, stripe: 1, figma: 3 },
      };
      const result = validateAndRepairProfile(withGoodTiers);
      expect(result!.tiers).toEqual({ ramp: 2, stripe: 1, figma: 3 });
    });

    it('preserves bounded scoring adjustments selected from outcome insights', () => {
      const result = validateAndRepairProfile({
        ...makeTestProfile(),
        scoring_adjustments: {
          tier_bonus: { '1': -2, '2': 5, '3': 10 },
          freshness_bonus: { max_days: 3, points: 5 },
        },
      });

      expect(result?.scoring_adjustments).toEqual({
        tier_bonus: { '1': -2, '2': 5, '3': 10 },
        freshness_bonus: { max_days: 3, points: 5 },
      });
    });

    it('drops malformed or out-of-bounds scoring adjustments', () => {
      const result = validateAndRepairProfile({
        ...makeTestProfile(),
        scoring_adjustments: {
          tier_bonus: { '1': 11, '2': 'five', '4': 3 },
          freshness_bonus: { max_days: -1, points: 50 },
        },
      });

      expect(result?.scoring_adjustments).toBeUndefined();
    });

    it('rejects non-object input', () => {
      expect(validateAndRepairProfile(null)).toBeNull();
      expect(validateAndRepairProfile('string')).toBeNull();
      expect(validateAndRepairProfile(42)).toBeNull();
      expect(validateAndRepairProfile([])).toBeNull();
    });

    it('rejects empty string in required fields', () => {
      const emptyGrad = {
        graduation: '',
        current_class_year: 'junior',
        work_auth: 'us_citizen',
        requires_sponsorship: false,
      };
      expect(validateAndRepairProfile(emptyGrad)).toBeNull();
    });
  });

  describe('clearProfile', () => {
    it('removes profile from localStorage', () => {
      saveProfile(makeTestProfile());
      expect(loadProfile()).not.toBeNull();
      clearProfile();
      expect(loadProfile()).toBeNull();
    });
  });
});

describe('category profile options', () => {
  it('groups every expanded category for profile selection', () => {
    expect(CATEGORY_GROUPS.map((group) => group.label)).toEqual([
      'Engineering',
      'Business',
      'Other',
    ]);
    expect(CATEGORY_GROUPS.flatMap((group) => group.options).map((option) => option.value))
      .toContain('supply-chain');
  });
});

describe('computeGradWindow', () => {
  it('computes window around May graduation', () => {
    const [start, end] = computeGradWindow('2029-05');
    expect(start).toBe('2028-11');
    expect(end).toBe('2029-06');
  });

  it('handles January graduation (wraps year backward)', () => {
    const [start, end] = computeGradWindow('2029-01');
    expect(start).toBe('2028-07');
    expect(end).toBe('2029-02');
  });

  it('handles December graduation (wraps year forward)', () => {
    const [start, end] = computeGradWindow('2028-12');
    expect(start).toBe('2028-06');
    expect(end).toBe('2029-01');
  });

  it('handles June graduation', () => {
    const [start, end] = computeGradWindow('2027-06');
    expect(start).toBe('2026-12');
    expect(end).toBe('2027-07');
  });

  it('handles invalid format gracefully', () => {
    const [start, end] = computeGradWindow('invalid');
    expect(start).toBe('invalid');
    expect(end).toBe('invalid');
  });
});

describe('inferRequiresSponsorship', () => {
  it('returns false for us_citizen', () => {
    expect(inferRequiresSponsorship('us_citizen')).toBe(false);
  });

  it('returns false for permanent_resident', () => {
    expect(inferRequiresSponsorship('permanent_resident')).toBe(false);
  });

  it('returns true for f1_opt_cpt', () => {
    expect(inferRequiresSponsorship('f1_opt_cpt')).toBe(true);
  });

  it('returns true for h1b', () => {
    expect(inferRequiresSponsorship('h1b')).toBe(true);
  });

  it('returns null for other (user must answer)', () => {
    expect(inferRequiresSponsorship('other')).toBeNull();
  });

  it('returns null for unknown work auth value', () => {
    expect(inferRequiresSponsorship('unknown_type')).toBeNull();
  });
});
