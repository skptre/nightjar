import { beforeEach, describe, expect, it } from 'vitest';
import { NightjarDB } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import {
  CATEGORY_GROUPS,
  CATEGORY_VALUES,
  parseCategoryTags,
  matchesCategorySelection,
} from './types';
import { classifyCategory } from './category-classifier';
import { scorePosting } from './scoring';
import { recomputePendingCategoryTaxonomy } from './recompute';
import { SyncManager } from '@/sync/sync-manager';

const EXPECTED_CATEGORIES = [
  'swe',
  'data-ml',
  'quant',
  'hardware',
  'mechE',
  'ECE',
  'aero',
  'civil',
  'chemE',
  'bioE',
  'finance',
  'accounting',
  'consulting',
  'research',
  'design',
  'operations',
  'supply-chain',
  'product', 'it', 'marketing', 'sales', 'people', 'legal', 'healthcare',
  'other',
] as const;

const EXPECTED_GROUPED_CATEGORIES = [
  'it', 'swe', 'data-ml', 'hardware', 'mechE', 'ECE', 'aero', 'civil', 'chemE', 'bioE',
  'quant', 'product', 'marketing', 'sales', 'people', 'legal', 'finance', 'accounting', 'consulting',
  'healthcare', 'research', 'design', 'operations', 'supply-chain',
] as const;

function makeProfile(targetCategories: string[]): Profile {
  return {
    graduation: '2029-05',
    grad_window: ['2028-11', '2029-06'],
    current_class_year: 'junior',
    work_auth: 'us_citizen',
    requires_sponsorship: false,
    target_categories: targetCategories,
    locations: ['US'],
    excluded_companies: [],
    tiers: {},
    contacts: {},
  };
}

function makePosting(id: string, title: string): FeedPosting {
  return {
    id,
    company: 'TestCo',
    company_slug: 'testco',
    title,
    location: 'New York, NY',
    locations: ['New York, NY'],
    url: `https://example.com/jobs/${id}`,
    source: 'test',
    source_job_id: id,
    ats: 'test',
    posted_at: '2026-09-01T00:00:00Z',
    first_seen_at: '2026-09-01T00:00:00Z',
    last_seen_at: '2026-09-01T00:00:00Z',
    closed_at: null,
  };
}

describe('Block 7 category taxonomy', () => {
  it('exposes every category exactly once in grouped profile order', () => {
    expect(CATEGORY_VALUES).toEqual(EXPECTED_CATEGORIES);
    expect(CATEGORY_GROUPS.map((group) => group.label)).toEqual([
      'Engineering',
      'Business',
      'Other',
    ]);
    expect(CATEGORY_GROUPS.flatMap((group) => group.options.map((option) => option.value)))
      .toEqual(EXPECTED_GROUPED_CATEGORIES);
  });

  it.each([
    ['Mechanical Engineering Intern', 'mechE'],
    ['Aerospace Systems Intern', 'aero'],
    ['Financial Analyst Summer 2027', 'finance'],
    ['Electrical Engineering Co-op', 'ECE'],
    ['Chemical Engineering Intern', 'chemE'],
    ['Supply Chain Analyst Intern', 'supply-chain'],
    ['Software Engineering Intern', 'swe'],
    ['Machine Learning Engineer Intern', 'data-ml'],
    ['Hardware Engineering Intern', 'hardware'],
    ['Civil Engineering Intern', 'civil'],
    ['Biomedical Engineering Intern', 'bioE'],
    ['Audit Intern', 'accounting'],
    ['Management Consulting Intern', 'consulting'],
    ['Research Assistant Intern', 'research'],
    ['UX Designer Intern', 'design'],
    ['Business Operations Intern', 'operations'],
  ] as const)('classifies %s as %s', (title, expected) => {
    const result = classifyCategory(title, null);
    expect(result.category).toBe(expected);
    expect(result.category_tags[0]).toBe(expected);
    expect(result.matched_in).toBe('title');
  });

  it('keeps specific and cross-discipline tags for ML software roles', () => {
    const result = classifyCategory('ML Software Engineer Intern', null);
    expect(result.category).toBe('data-ml');
    expect(result.category_tags).toEqual(['data-ml', 'swe']);
  });

  it('classifies quant software by its work and records its field', () => {
    const result = classifyCategory('Quantitative Software Developer Intern', null);
    expect(result.category).toBe('swe');
    expect(result.domain_tags).toContain('quant');
    expect(result.category_tags).toEqual(['swe']);
  });

  it('keeps a title match primary even when the description has a higher-priority rule', () => {
    const result = classifyCategory(
      'Software Engineering Intern',
      'Train machine learning models for computer vision.',
    );
    expect(result.category).toBe('swe');
    expect(result.category_tags).toEqual(['swe']);
    expect(result.matched_in).toBe('title');
  });

  it.each([
    ['Bioinformatics Intern', 'bioE'],
    ['Equity Research Summer Analyst', 'finance'],
    ['UX Researcher Intern', 'design'],
    ['Industrial Designer Intern', 'design'],
    ['Warehouse Operations Intern', 'supply-chain'],
    ['Flight Test Engineering Intern', 'aero'],
    ['Power Electronics Co-op', 'ECE'],
    ['Embedded Software Intern', 'hardware'],
  ] as const)('resolves overlapping title %s to %s', (title, expected) => {
    expect(classifyCategory(title, null).category).toBe(expected);
  });

  it('does not turn tools used in a description into additional professions', () => {
    const result = classifyCategory(
      'Mechanical Engineering Intern',
      'Build circuit design prototypes and web developer tools.',
    );
    expect(result.category).toBe('mechE');
    expect(result.category_tags).toEqual(['mechE']);
    expect(result.matched_in).toBe('title');
  });

  it('does not invent three professions from robotics alone', () => {
    const result = classifyCategory('Robotics Engineering Intern', null);
    expect(result.category).toBe('mechE');
    expect(result.category_tags).toEqual(['mechE']);
  });

  it('classifies aerospace controls as aerospace work', () => {
    const result = classifyCategory('Aerospace Controls Intern', null);
    expect(result.category).toBe('aero');
    expect(result.category_tags).toEqual(['aero']);
  });

  it('does not add unrelated tags to robotics software', () => {
    const result = classifyCategory(
      'Robotics Software Engineering Intern',
      'Machine learning research for biomedical flight-control hardware.',
    );
    expect(result.category_tags).toHaveLength(1);
    expect(new Set(result.category_tags).size).toBe(1);
    expect(result.category_tags).toEqual(['swe']);
  });

  it('keeps an ambiguous engineering internship in other', () => {
    expect(classifyCategory('Engineering Intern', null)).toMatchObject({
      category: 'other',
      category_tags: ['other'],
      matched_in: null,
    });
  });

  it('matches keywords at token boundaries', () => {
    expect(classifyCategory('Sweeper Operations Intern', null).category).toBe('operations');
  });

  it('uses a structured source category after title and description evidence', () => {
    const result = classifyCategory('Summer Intern', null, 'Data Science');
    expect(result.category).toBe('data-ml');
    expect(result.category_tags).toEqual(['data-ml']);
    expect(result.matched_rule).toBe('simplify:Data Science');
  });
});

describe('category tag compatibility helpers', () => {
  it('parses stored tags and migrates the old ml category', () => {
    expect(parseCategoryTags('["ml","swe"]', 'ml')).toEqual(['data-ml', 'swe']);
  });

  it('falls back safely when stored tag JSON is missing or malformed', () => {
    expect(parseCategoryTags(null, 'ml')).toEqual(['data-ml']);
    expect(parseCategoryTags('{broken', 'mechE')).toEqual(['mechE']);
    expect(parseCategoryTags(null, null)).toEqual(['other']);
  });

  it('filters on any tag rather than only the primary category', () => {
    const selected = new Set(['swe']);
    expect(matchesCategorySelection(['mechE', 'ECE', 'swe'], 'mechE', selected)).toBe(true);
    expect(matchesCategorySelection(['mechE', 'ECE'], 'mechE', selected)).toBe(false);
    expect(matchesCategorySelection(['mechE'], 'mechE', new Set())).toBe(true);
  });
});

describe('multi-label category scoring', () => {
  const now = new Date('2026-09-02T00:00:00Z');

  it('awards a full category match when any category tag overlaps', () => {
    const result = scorePosting(
      {
        company_slug: 'testco',
        first_seen_at: now.toISOString(),
        eligibility_verdict: 'unclear',
        category: 'mechE',
        category_tags: ['mechE', 'ECE', 'swe'],
      },
      makeProfile(['swe']),
      now,
    );
    expect(result.breakdown.category).toBe(20);
  });

  it('scores planned mechE/aero targets and a nonmatching SWE role correctly', () => {
    const profile = makeProfile(['mechE', 'aero']);
    const base = {
      company_slug: 'testco',
      first_seen_at: now.toISOString(),
      eligibility_verdict: 'unclear' as const,
    };

    expect(scorePosting({ ...base, category: 'mechE', category_tags: ['mechE'] }, profile, now)
      .breakdown.category).toBe(20);
    expect(scorePosting({ ...base, category: 'aero', category_tags: ['aero'] }, profile, now)
      .breakdown.category).toBe(20);
    expect(scorePosting({ ...base, category: 'swe', category_tags: ['swe'] }, profile, now)
      .breakdown.category).toBe(5);
  });

  it('only awards the neutral score when the primary category is other', () => {
    const result = scorePosting(
      {
        company_slug: 'testco',
        first_seen_at: now.toISOString(),
        eligibility_verdict: 'unclear',
        category: 'other',
        category_tags: ['other'],
      },
      makeProfile(['finance']),
      now,
    );
    expect(result.breakdown.category).toBe(10);
  });

  it('falls back to the primary category if a legacy caller supplies no tags', () => {
    const result = scorePosting(
      {
        company_slug: 'testco',
        first_seen_at: now.toISOString(),
        eligibility_verdict: 'unclear',
        category: 'finance',
        category_tags: [],
      },
      makeProfile(['finance']),
      now,
    );
    expect(result.breakdown.category).toBe(20);
  });
});

describe('cached category migration', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  it('refreshes version-one classifications with already cached top-level departments', async () => {
    const posting = { ...makePosting('department-1', 'Summer Intern'),
      department: 'Software Engineering - Avionics' };
    await db.run(`INSERT INTO postings_cache
      (id, data, first_seen_at, category, category_tags, classification_version, synced_at)
      VALUES (?, ?, ?, 'other', '[]', 1, ?)`,
    [posting.id, JSON.stringify(posting), posting.first_seen_at, posting.first_seen_at]);
    expect(await recomputePendingCategoryTaxonomy(db, makeProfile(['swe']))).toBe(1);
    const row = await db.queryOne<{ category: string; classification_version: number }>(
      'SELECT category, classification_version FROM postings_cache WHERE id = ?', [posting.id]);
    expect(row).toMatchObject({ category: 'swe', classification_version: 5 });
    expect(await recomputePendingCategoryTaxonomy(db, makeProfile(['swe']))).toBe(0);
  });

  it('reclassifies open rows whose category tags have not been populated', async () => {
    const posting = makePosting('mechanical-1', 'Mechanical Engineering Intern');
    await db.run(
      `INSERT INTO postings_cache
       (id, data, first_seen_at, category, category_tags, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        posting.id,
        JSON.stringify(posting),
        posting.first_seen_at,
        'ml',
        null,
        posting.first_seen_at,
      ],
    );

    expect(await recomputePendingCategoryTaxonomy(db, makeProfile(['mechE']))).toBe(1);

    const row = await db.queryOne<{ category: string; category_tags: string; score: number }>(
      'SELECT category, category_tags, score FROM postings_cache WHERE id = ?',
      [posting.id],
    );
    expect(row?.category).toBe('mechE');
    expect(JSON.parse(row?.category_tags ?? '[]')).toEqual(['mechE']);
    expect(row?.score).toBeTypeOf('number');
    expect(await recomputePendingCategoryTaxonomy(db, makeProfile(['mechE']))).toBe(0);
  });

  it('reclassifies closed cached postings as part of the one-time cache migration', async () => {
    const posting = { ...makePosting('closed-1', 'Mechanical Engineering Intern'), closed_at: '2026-09-02T00:00:00Z' };
    await db.run(
      `INSERT INTO postings_cache
       (id, data, first_seen_at, closed_at, category, category_tags, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        posting.id,
        JSON.stringify(posting),
        posting.first_seen_at,
        posting.closed_at,
        'ml',
        null,
        posting.first_seen_at,
      ],
    );

    expect(await recomputePendingCategoryTaxonomy(db, makeProfile(['mechE']))).toBe(1);

    const row = await db.queryOne<{ category: string; category_tags: string }>(
      'SELECT category, category_tags FROM postings_cache WHERE id = ?',
      [posting.id],
    );
    expect(row?.category).toBe('mechE');
    expect(JSON.parse(row?.category_tags ?? '[]')).toEqual(['mechE']);
  });

  it('runs the first-launch cache migration while offline', async () => {
    const posting = makePosting('offline-1', 'Aerospace Systems Intern');
    await db.run(
      `INSERT INTO postings_cache
       (id, data, first_seen_at, category, category_tags, synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [posting.id, JSON.stringify(posting), posting.first_seen_at, 'other', null, posting.first_seen_at],
    );

    const originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(Navigator.prototype, 'onLine', {
      get: () => false,
      configurable: true,
    });

    try {
      const manager = new SyncManager(db);
      manager.setProfile(makeProfile(['aero']));
      expect(await manager.doSync()).toBeNull();

      const row = await db.queryOne<{ category: string; category_tags: string }>(
        'SELECT category, category_tags FROM postings_cache WHERE id = ?',
        [posting.id],
      );
      expect(row?.category).toBe('aero');
      expect(JSON.parse(row?.category_tags ?? '[]')).toEqual(['aero']);
      expect(manager.getState().lastError).toBe('Offline');
    } finally {
      if (originalOnLine) {
        Object.defineProperty(Navigator.prototype, 'onLine', originalOnLine);
      }
    }
  });
});
