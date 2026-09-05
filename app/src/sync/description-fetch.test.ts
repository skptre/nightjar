import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import {
  parseGreenhouseUrl,
  parseLeverUrl,
  parseAshbyUrl,
  parseWorkdayUrl,
  htmlToPlaintext,
  unescapeHtml,
  DescriptionFetcher,
  prefetchDescriptions,
} from './description-fetch';

async function insertPosting(
  db: NightjarDB,
  id: string,
  overrides: Partial<{
    url: string;
    source: string;
    ats: string;
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
    ats: overrides.ats ?? overrides.source ?? 'greenhouse',
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

describe('URL parsing', () => {
  describe('parseGreenhouseUrl', () => {
    it('extracts token and jobId', () => {
      const result = parseGreenhouseUrl('https://boards.greenhouse.io/ramp/jobs/12345');
      expect(result).toEqual({ token: 'ramp', jobId: '12345' });
    });

    it('supports the current job-boards hostname', () => {
      expect(parseGreenhouseUrl('https://job-boards.greenhouse.io/ramp/jobs/12345'))
        .toEqual({ token: 'ramp', jobId: '12345' });
    });

    it('handles URLs with query params', () => {
      const result = parseGreenhouseUrl('https://boards.greenhouse.io/stripe/jobs/67890?gh_jid=67890');
      expect(result).toEqual({ token: 'stripe', jobId: '67890' });
    });

    it('handles URLs with hash', () => {
      const result = parseGreenhouseUrl('https://boards.greenhouse.io/figma/jobs/99999#details');
      expect(result).toEqual({ token: 'figma', jobId: '99999' });
    });

    it('returns null for non-greenhouse URLs', () => {
      expect(parseGreenhouseUrl('https://jobs.lever.co/cloudflare/abc')).toBeNull();
    });

    it('returns null for malformed URLs', () => {
      expect(parseGreenhouseUrl('https://boards.greenhouse.io/ramp')).toBeNull();
    });
  });

  describe('parseLeverUrl', () => {
    it('extracts slug and jobId', () => {
      const result = parseLeverUrl('https://jobs.lever.co/cloudflare/abc-123');
      expect(result).toEqual({ slug: 'cloudflare', jobId: 'abc-123' });
    });

    it('handles UUIDs as job IDs', () => {
      const result = parseLeverUrl('https://jobs.lever.co/retool/a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(result).toEqual({
        slug: 'retool',
        jobId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      });
    });

    it('supports EU Lever boards', () => {
      expect(parseLeverUrl('https://jobs.eu.lever.co/cloudflare/abc-123'))
        .toEqual({ slug: 'cloudflare', jobId: 'abc-123' });
    });

    it('returns null for non-lever URLs', () => {
      expect(parseLeverUrl('https://boards.greenhouse.io/ramp/jobs/1')).toBeNull();
    });
  });

  describe('parseAshbyUrl', () => {
    it('extracts slug', () => {
      const result = parseAshbyUrl('https://jobs.ashbyhq.com/anthropic/abc-123');
      expect(result).toEqual({ slug: 'anthropic', jobId: 'abc-123' });
    });

    it('handles slug-only URLs', () => {
      const result = parseAshbyUrl('https://jobs.ashbyhq.com/linear');
      expect(result).toEqual({ slug: 'linear' });
    });

    it('returns null for non-ashby URLs', () => {
      expect(parseAshbyUrl('https://jobs.lever.co/foo/bar')).toBeNull();
    });
  });

  describe('parseWorkdayUrl', () => {
    it('keeps the career site required by the CXS detail endpoint', () => {
      expect(parseWorkdayUrl(
        'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Santa-Clara/SWE-Intern_JR1',
      )).toEqual({
        host: 'nvidia.wd5.myworkdayjobs.com',
        tenant: 'nvidia',
        site: 'NVIDIAExternalCareerSite',
        path: '/job/Santa-Clara/SWE-Intern_JR1',
      });
    });

    it('rejects legacy site-less URLs instead of building a broken API URL', () => {
      expect(parseWorkdayUrl(
        'https://nvidia.wd5.myworkdayjobs.com/job/Santa-Clara/SWE-Intern_JR1',
      )).toBeNull();
    });
  });
});

describe('htmlToPlaintext', () => {
  it('strips HTML tags', () => {
    expect(htmlToPlaintext('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('unescapes HTML entities', () => {
    expect(htmlToPlaintext('foo &amp; bar')).toBe('foo & bar');
  });

  it('handles double-encoded entities', () => {
    expect(htmlToPlaintext('&amp;amp;')).toBe('&');
  });

  it('handles triple-encoded entities', () => {
    expect(htmlToPlaintext('&amp;amp;amp;')).toBe('&');
  });

  it('collapses whitespace', () => {
    expect(htmlToPlaintext('  foo   bar  ')).toBe('foo bar');
  });

  it('caps output at 5000 chars', () => {
    const long = 'x'.repeat(6000);
    expect(htmlToPlaintext(long)).toHaveLength(5000);
  });

  it('returns empty string for empty input', () => {
    expect(htmlToPlaintext('')).toBe('');
  });

  it('handles numeric entities', () => {
    expect(htmlToPlaintext('&#8212;')).toBe('—');
  });

  it('handles hex entities', () => {
    expect(htmlToPlaintext('&#x2019;')).toBe('’');
  });

  it('preserves unicode text', () => {
    expect(htmlToPlaintext('<p>日本語テスト</p>')).toBe('日本語テスト');
  });
});

describe('unescapeHtml', () => {
  it('unescapes common entities', () => {
    expect(unescapeHtml('&lt;div&gt;')).toBe('<div>');
    expect(unescapeHtml('&quot;hello&quot;')).toBe('"hello"');
    expect(unescapeHtml('it&#39;s')).toBe("it's");
    expect(unescapeHtml('a &amp; b')).toBe('a & b');
  });

  it('unescapes nbsp', () => {
    expect(unescapeHtml('hello&nbsp;world')).toBe('hello world');
  });
});

describe('DescriptionFetcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches greenhouse description with HTML-to-plaintext', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('boards-api.greenhouse.io')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: '<p>We are looking for a <b>talented</b> engineer.</p>',
          }),
        });
      }
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'p1',
      url: 'https://boards.greenhouse.io/ramp/jobs/12345',
      source: 'greenhouse',
      source_job_id: '12345',
      company_slug: 'ramp',
    });

    expect(result.description).toBe('We are looking for a talented engineer.');
    expect(result.error).toBeNull();
  });

  it('fetches lever description as plaintext', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('api.lever.co')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            descriptionPlain: 'Join our team as a software engineer.',
          }),
        });
      }
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'p2',
      url: 'https://jobs.lever.co/cloudflare/abc-123',
      source: 'lever',
      source_job_id: 'abc-123',
      company_slug: 'cloudflare',
    });

    expect(result.description).toBe('Join our team as a software engineer.');
    expect(result.error).toBeNull();
  });

  it('fetches ashby description from board response', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('api.ashbyhq.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            jobs: [
              { id: 'job-1', descriptionPlain: 'First job description' },
              { id: 'job-2', descriptionPlain: 'Second job description' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'p3',
      url: 'https://jobs.ashbyhq.com/anthropic/job-2',
      source: 'ashby',
      source_job_id: 'job-2',
      company_slug: 'anthropic',
    });

    expect(result.description).toBe('Second job description');
  });

  it('uses the Ashby ID in a Simplify URL', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        jobs: [{ id: 'ashby-job', descriptionPlain: 'Matched by URL' }],
      }),
    })));

    const result = await new DescriptionFetcher().fetchOne({
      id: 'simplify-row',
      url: 'https://jobs.ashbyhq.com/linear/ashby-job',
      source: 'simplify',
      ats: 'ashby',
      source_job_id: 'simplify-source-id',
      company_slug: 'linear',
    });

    expect(result.description).toBe('Matched by URL');
  });

  it('caches ashby board response for same company', async () => {
    let fetchCount = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('api.ashbyhq.com')) {
        fetchCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            jobs: [
              { id: 'j1', descriptionPlain: 'Desc 1' },
              { id: 'j2', descriptionPlain: 'Desc 2' },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false });
    }));

    const fetcher = new DescriptionFetcher();

    const r1 = await fetcher.fetchOne({
      id: 'p1', url: 'https://jobs.ashbyhq.com/linear/j1',
      source: 'ashby', source_job_id: 'j1', company_slug: 'linear',
    });
    const r2 = await fetcher.fetchOne({
      id: 'p2', url: 'https://jobs.ashbyhq.com/linear/j2',
      source: 'ashby', source_job_id: 'j2', company_slug: 'linear',
    });

    expect(r1.description).toBe('Desc 1');
    expect(r2.description).toBe('Desc 2');
    expect(fetchCount).toBe(1);
  });

  it('handles CORS/network error gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'p1',
      url: 'https://boards.greenhouse.io/test/jobs/1',
      source: 'greenhouse',
      source_job_id: '1',
      company_slug: 'test',
    });

    expect(result.description).toBeNull();
    expect(result.error).toContain('Failed to fetch');
    expect(fetcher.getCorsFailures()).toContain('greenhouse:test');
  });

  it('handles API returning non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: false, status: 404 }),
    ));

    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'p1',
      url: 'https://boards.greenhouse.io/test/jobs/1',
      source: 'greenhouse',
      source_job_id: '1',
      company_slug: 'test',
    });

    expect(result.description).toBeNull();
    expect(result.error).toBeNull();
  });

  it('returns null for unparseable URLs', async () => {
    const fetcher = new DescriptionFetcher();
    const result = await fetcher.fetchOne({
      id: 'p1',
      url: 'https://example.com/some-random-page',
      source: 'greenhouse',
      source_job_id: '1',
      company_slug: 'test',
    });

    expect(result.description).toBeNull();
  });

  it('enforces per-host delay', async () => {
    const timestamps: number[] = [];
    vi.stubGlobal('fetch', vi.fn(() => {
      timestamps.push(Date.now());
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ descriptionPlain: 'desc' }),
      });
    }));

    const fetcher = new DescriptionFetcher();

    await fetcher.fetchOne({
      id: 'p1', url: 'https://jobs.lever.co/co1/j1',
      source: 'lever', source_job_id: 'j1', company_slug: 'co1',
    });
    await fetcher.fetchOne({
      id: 'p2', url: 'https://jobs.lever.co/co2/j2',
      source: 'lever', source_job_id: 'j2', company_slug: 'co2',
    });

    expect(timestamps).toHaveLength(2);
    const gap = timestamps[1]! - timestamps[0]!;
    expect(gap).toBeGreaterThanOrEqual(450);
  });
});

describe('prefetchDescriptions', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
  });

  it('skips postings with existing descriptions', async () => {
    await insertPosting(db, 'cached', {
      description: 'Already fetched',
      source: 'greenhouse',
      url: 'https://boards.greenhouse.io/test/jobs/1',
      source_job_id: '1',
    });

    let fetchCalled = false;
    vi.stubGlobal('fetch', vi.fn(() => {
      fetchCalled = true;
      return Promise.resolve({ ok: false });
    }));

    const results = await prefetchDescriptions(db, 50);

    expect(results).toHaveLength(0);
    expect(fetchCalled).toBe(false);
  });

  it('fetches and stores descriptions for postings without them', async () => {
    await insertPosting(db, 'p1', {
      source: 'lever',
      url: 'https://jobs.lever.co/testco/abc',
      source_job_id: 'abc',
    });

    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ descriptionPlain: 'Fetched description text' }),
      }),
    ));

    const results = await prefetchDescriptions(db, 50);

    expect(results).toHaveLength(1);
    expect(results[0]!.description).toBe('Fetched description text');

    const row = await db.queryOne<{ description: string | null }>(
      'SELECT description FROM postings_cache WHERE id = ?',
      ['p1'],
    );
    expect(row!.description).toBe('Fetched description text');
  });

  it('uses the underlying ATS for Simplify postings', async () => {
    await insertPosting(db, 'simplify-lever', {
      source: 'simplify',
      ats: 'lever',
      url: 'https://jobs.lever.co/testco/abc',
      source_job_id: 'abc',
    });

    const fetchMock = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ descriptionPlain: 'Lever detail via Simplify' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await prefetchDescriptions(db, 1);

    expect(results[0]?.description).toBe('Lever detail via Simplify');
    expect(fetchMock).toHaveBeenCalledWith('https://api.lever.co/v0/postings/testco/abc');
  });

  it('backs off failed rows so a fresh row is not starved', async () => {
    await insertPosting(db, 'first', {
      source: 'greenhouse',
      url: 'https://boards.greenhouse.io/testco/jobs/111',
      score: 100,
    });
    await insertPosting(db, 'second', {
      source: 'greenhouse',
      url: 'https://boards.greenhouse.io/testco/jobs/222',
      source_job_id: '222',
      score: 10,
    });

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));

    const firstPass = await prefetchDescriptions(db, 1);
    const secondPass = await prefetchDescriptions(db, 1);

    expect(firstPass.map((result) => result.id)).toEqual(['first']);
    expect(secondPass.map((result) => result.id)).toEqual(['second']);
    const attempted = await db.query<{ id: string; description_attempted_at: string | null }>(
      'SELECT id, description_attempted_at FROM postings_cache ORDER BY id',
    );
    expect(attempted.every((row) => row.description_attempted_at !== null)).toBe(true);
  });

  it('skips closed postings', async () => {
    await db.run(
      `INSERT INTO postings_cache (id, data, first_seen_at, closed_at, synced_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'closed1',
        JSON.stringify({
          url: 'https://boards.greenhouse.io/test/jobs/1',
          source: 'greenhouse',
          source_job_id: '1',
          company_slug: 'test',
        }),
        '2026-08-01T00:00:00Z',
        '2026-08-10T00:00:00Z',
        '2026-08-12T00:00:00Z',
      ],
    );

    let fetchCalled = false;
    vi.stubGlobal('fetch', vi.fn(() => {
      fetchCalled = true;
      return Promise.resolve({ ok: false });
    }));

    const results = await prefetchDescriptions(db, 50);

    expect(results).toHaveLength(0);
    expect(fetchCalled).toBe(false);
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await insertPosting(db, `p${String(i)}`, {
        source: 'lever',
        url: `https://jobs.lever.co/co${String(i)}/j${String(i)}`,
        source_job_id: `j${String(i)}`,
        company_slug: `co${String(i)}`,
      });
    }

    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ descriptionPlain: 'desc' }),
      }),
    ));

    const results = await prefetchDescriptions(db, 2);
    expect(results).toHaveLength(2);
  });

  it('prioritizes higher-scored postings', async () => {
    await insertPosting(db, 'low', {
      source: 'lever', url: 'https://jobs.lever.co/low/j1',
      source_job_id: 'j1', company_slug: 'low', score: 20,
    });
    await insertPosting(db, 'high', {
      source: 'lever', url: 'https://jobs.lever.co/high/j2',
      source_job_id: 'j2', company_slug: 'high', score: 90,
    });

    const fetchedIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/high/')) fetchedIds.push('high');
      if (url.includes('/low/')) fetchedIds.push('low');
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ descriptionPlain: 'desc' }),
      });
    }));

    await prefetchDescriptions(db, 50);

    expect(fetchedIds[0]).toBe('high');
  });

  it('does not crash on malformed posting data', async () => {
    await db.run(
      'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
      ['bad', 'not-json', '2026-08-01T00:00:00Z', '2026-08-12T00:00:00Z'],
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));

    const results = await prefetchDescriptions(db, 50);
    expect(results).toHaveLength(0);
  });

  it('returns empty array when no postings need descriptions', async () => {
    const results = await prefetchDescriptions(db, 50);
    expect(results).toHaveLength(0);
  });
});
