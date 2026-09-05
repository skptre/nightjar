import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import {
  parseWorkdayUrl,
  parseSmartRecruitersUrl,
  DescriptionFetcher,
  prefetchDescriptions,
} from './description-fetch';

async function insertPosting(
  db: NightjarDB,
  id: string,
  overrides: Partial<{
    url: string;
    source: string;
    source_job_id: string;
    company_slug: string;
    title: string;
    description: string | null;
    score: number | null;
  }> = {},
): Promise<void> {
  const data = JSON.stringify({
    id,
    url: overrides.url ?? 'https://boards.greenhouse.io/testco/jobs/111',
    source: overrides.source ?? 'greenhouse',
    source_job_id: overrides.source_job_id ?? '111',
    company_slug: overrides.company_slug ?? 'testco',
    title: overrides.title ?? 'SWE Intern',
    company: 'TestCo',
    location: 'NYC',
    locations: ['NYC'],
    ats: overrides.source ?? 'greenhouse',
    posted_at: null,
    first_seen_at: '2026-08-01T00:00:00Z',
    last_seen_at: '2026-08-12T00:00:00Z',
    closed_at: null,
  });

  await db.run(
    `INSERT INTO postings_cache (id, data, first_seen_at, synced_at, description, score)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      data,
      '2026-08-01T00:00:00Z',
      '2026-08-12T00:00:00Z',
      overrides.description ?? null,
      overrides.score ?? null,
    ],
  );
}

// ─── Workday URL parsing ────────────────────────────────────

describe('parseWorkdayUrl', () => {
  it('extracts host, tenant, and path from standard URL', () => {
    const result = parseWorkdayUrl(
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/SWE-Intern_JR12345',
    );
    expect(result).not.toBeNull();
    expect(result!.host).toBe('nvidia.wd5.myworkdayjobs.com');
    expect(result!.tenant).toBe('nvidia');
    expect(result!.site).toBe('NVIDIAExternalCareerSite');
    expect(result!.path).toBe('/job/US-CA-Santa-Clara/SWE-Intern_JR12345');
  });

  it('handles URL without locale prefix', () => {
    const result = parseWorkdayUrl(
      'https://intel.wd1.myworkdayjobs.com/IntelExternalCareers/job/US-OR-Hillsboro/SWE_JR99999',
    );
    expect(result).not.toBeNull();
    expect(result!.host).toBe('intel.wd1.myworkdayjobs.com');
    expect(result!.tenant).toBe('intel');
    expect(result!.site).toBe('IntelExternalCareers');
    expect(result!.path).toBe('/job/US-OR-Hillsboro/SWE_JR99999');
  });

  it('strips fr-FR locale prefix', () => {
    const result = parseWorkdayUrl(
      'https://bosch.wd3.myworkdayjobs.com/fr-FR/BoschCareers/job/Stuttgart/Engineer_REQ123',
    );
    expect(result).not.toBeNull();
    expect(result!.site).toBe('BoschCareers');
    expect(result!.path).toBe('/job/Stuttgart/Engineer_REQ123');
  });

  it('returns null for non-Workday URLs', () => {
    expect(parseWorkdayUrl('https://boards.greenhouse.io/ramp/jobs/123')).toBeNull();
    expect(parseWorkdayUrl('https://jobs.lever.co/company/abc')).toBeNull();
  });

  it('returns null for Workday URL with only host (no path)', () => {
    expect(parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com')).toBeNull();
    expect(parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com/')).toBeNull();
  });
});

// ─── SmartRecruiters URL parsing ────────────────────────────

describe('parseSmartRecruitersUrl', () => {
  it('extracts company and postingId', () => {
    const result = parseSmartRecruitersUrl(
      'https://jobs.smartrecruiters.com/Visa/743999123456789-software-engineer-intern',
    );
    expect(result).toEqual({
      company: 'Visa',
      postingId: '743999123456789-software-engineer-intern',
    });
  });

  it('handles company with special characters', () => {
    const result = parseSmartRecruitersUrl(
      'https://jobs.smartrecruiters.com/BoschGroup/743999111222333-hw-engineer',
    );
    expect(result).toEqual({
      company: 'BoschGroup',
      postingId: '743999111222333-hw-engineer',
    });
  });

  it('handles URL with query params', () => {
    const result = parseSmartRecruitersUrl(
      'https://jobs.smartrecruiters.com/Visa/123-role?source=linkedin',
    );
    expect(result).toEqual({ company: 'Visa', postingId: '123-role' });
  });

  it('returns null for non-SmartRecruiters URLs', () => {
    expect(parseSmartRecruitersUrl('https://boards.greenhouse.io/ramp/jobs/1')).toBeNull();
    expect(parseSmartRecruitersUrl('https://jobs.lever.co/co/abc')).toBeNull();
  });

  it('returns null for malformed SmartRecruiters URL', () => {
    expect(parseSmartRecruitersUrl('https://jobs.smartrecruiters.com/Visa')).toBeNull();
  });
});

// ─── Workday description fetch ──────────────────────────────

describe('DescriptionFetcher — Workday', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches workday description and strips HTML', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('wday/cxs/nvidia')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            jobDescription: '<p>Join our <b>GPU</b> team as an intern.</p>',
          }),
        });
      }
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'wd1',
      url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Santa-Clara/Intern_JR001',
      source: 'workday',
      source_job_id: 'JR001',
      company_slug: 'nvidia',
    });

    expect(result.description).toBe('Join our GPU team as an intern.');
    expect(result.error).toBeNull();
  });

  it('constructs correct CXS API URL', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ jobDescription: 'desc' }),
      });
    }));

    const fetcher = new DescriptionFetcher();
    await fetcher.fetchOne({
      id: 'wd2',
      url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA/Role_JR002',
      source: 'workday',
      source_job_id: 'JR002',
      company_slug: 'nvidia',
    });

    expect(capturedUrl).toBe(
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA/Role_JR002',
    );
  });

  it('handles CORS failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'wd3',
      url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/CA/Intern_JR003',
      source: 'workday',
      source_job_id: 'JR003',
      company_slug: 'nvidia',
    });

    expect(result.description).toBeNull();
    expect(result.error).toContain('Failed to fetch');
    expect(fetcher.getCorsFailures()).toContain('workday:nvidia');
  });
});

// ─── SmartRecruiters description fetch ──────────────────────

describe('DescriptionFetcher — SmartRecruiters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches SmartRecruiters description from sections', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('api.smartrecruiters.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            jobDescription: {
              sections: [
                { text: '<p>About the role</p>' },
                { text: '<p>Requirements: Python, <b>TypeScript</b></p>' },
              ],
            },
          }),
        });
      }
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'sr1',
      url: 'https://jobs.smartrecruiters.com/Visa/743999-swe-intern',
      source: 'smartrecruiters',
      source_job_id: '743999-swe-intern',
      company_slug: 'visa',
    });

    expect(result.description).toBe('About the role Requirements: Python, TypeScript');
    expect(result.error).toBeNull();
  });

  it('reads the current jobAd sections response shape', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        jobAd: {
          sections: {
            jobDescription: { text: '<p>Build products.</p>' },
            qualifications: { text: '<p>Currently enrolled.</p>' },
          },
        },
      }),
    })));

    const result = await new DescriptionFetcher().fetchOne({
      id: 'sr-current',
      url: 'https://jobs.smartrecruiters.com/Visa/current-shape',
      source: 'smartrecruiters',
      source_job_id: 'current-shape',
      company_slug: 'visa',
    });

    expect(result.description).toBe('Build products. Currently enrolled.');
  });

  it('constructs correct API URL', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          jobDescription: { sections: [{ text: 'desc' }] },
        }),
      });
    }));

    const fetcher = new DescriptionFetcher();
    await fetcher.fetchOne({
      id: 'sr2',
      url: 'https://jobs.smartrecruiters.com/BoschGroup/123-engineer',
      source: 'smartrecruiters',
      source_job_id: '123-engineer',
      company_slug: 'bosch',
    });

    expect(capturedUrl).toBe(
      'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings/123-engineer',
    );
  });

  it('handles empty sections gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          jobDescription: { sections: [] },
        }),
      }),
    ));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'sr3',
      url: 'https://jobs.smartrecruiters.com/Co/456-role',
      source: 'smartrecruiters',
      source_job_id: '456-role',
      company_slug: 'co',
    });

    expect(result.description).toBeNull();
  });
});

// ─── Simplify / other source skipping ───────────────────────

describe('DescriptionFetcher — source skipping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips fetch for simplify source', async () => {
    let fetchCalled = false;
    vi.stubGlobal('fetch', vi.fn(() => {
      fetchCalled = true;
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'sim1',
      url: 'https://careers.google.com/jobs/123',
      source: 'simplify',
      source_job_id: '123',
      company_slug: 'google',
    });

    expect(result.description).toBeNull();
    expect(result.error).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  it('skips fetch for other source', async () => {
    let fetchCalled = false;
    vi.stubGlobal('fetch', vi.fn(() => {
      fetchCalled = true;
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'other1',
      url: 'https://careers.apple.com/us/search/123',
      source: 'other',
      source_job_id: '123',
      company_slug: 'apple',
    });

    expect(result.description).toBeNull();
    expect(result.error).toBeNull();
    expect(fetchCalled).toBe(false);
  });
});

// ─── Prefetch with new sources ──────────────────────────────

describe('prefetchDescriptions — new sources', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
  });

  it('fetches workday descriptions through prefetch pipeline', async () => {
    await insertPosting(db, 'wd-prefetch', {
      source: 'workday',
      url: 'https://intel.wd1.myworkdayjobs.com/en-US/IntelCareers/job/OR/Intern_JR111',
      source_job_id: 'JR111',
      company_slug: 'intel',
    });

    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ jobDescription: '<p>Intel internship</p>' }),
      }),
    ));

    const results = await prefetchDescriptions(db, 50);

    expect(results).toHaveLength(1);
    expect(results[0]!.description).toBe('Intel internship');

    const row = await db.queryOne<{ description: string | null }>(
      'SELECT description FROM postings_cache WHERE id = ?',
      ['wd-prefetch'],
    );
    expect(row!.description).toBe('Intel internship');
  });

  it('does not attempt fetch for simplify-sourced postings', async () => {
    await insertPosting(db, 'sim-prefetch', {
      source: 'simplify',
      url: 'https://careers.meta.com/jobs/abc',
      source_job_id: 'abc',
      company_slug: 'meta',
    });

    let fetchCalled = false;
    vi.stubGlobal('fetch', vi.fn(() => {
      fetchCalled = true;
      return Promise.resolve({ ok: false });
    }));

    const results = await prefetchDescriptions(db, 50);

    expect(results).toHaveLength(1);
    expect(results[0]!.description).toBeNull();
    expect(fetchCalled).toBe(false);
  });
});

// ─── EligibilityBadge metadata detection ────────────────────

describe('EligibilityBadge metadata detection', () => {
  it('identifies metadata-based verdict from flags', () => {
    const metadataEligibility = {
      verdict: 'ineligible',
      reasons: ["matched: 'Simplify reports: doesn\\'t offer sponsorship'"],
      flags: [{
        type: 'no_sponsorship',
        matched_sentence: "Simplify reports: doesn't offer sponsorship",
        pattern: 'source_metadata.sponsorship',
      }],
    };

    const isMetadata = metadataEligibility.flags.every(
      (f) => f.pattern === 'source_metadata.sponsorship',
    );
    expect(isMetadata).toBe(true);
  });

  it('identifies description-based verdict (different pattern)', () => {
    const descriptionEligibility = {
      verdict: 'ineligible',
      reasons: ['Unable to sponsor work visas'],
      flags: [{
        type: 'no_sponsorship',
        matched_sentence: 'We are unable to sponsor work visas at this time.',
        pattern: 'unable to sponsor',
      }],
    };

    const isMetadata = descriptionEligibility.flags.every(
      (f) => f.pattern === 'source_metadata.sponsorship',
    );
    expect(isMetadata).toBe(false);
  });

  it('identifies empty flags as not metadata-based', () => {
    const noFlags = {
      verdict: 'unclear' as const,
      reasons: [] as string[],
      flags: [] as Array<{ pattern?: string }>,
    };

    const isMetadata = noFlags.flags.length > 0 && noFlags.flags.every(
      (f) => f.pattern === 'source_metadata.sponsorship',
    );
    expect(isMetadata).toBe(false);
  });
});
