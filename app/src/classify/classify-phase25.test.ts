import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NightjarDB } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import { classifyTerm } from './term-classifier';
import { classifyCategory } from './category-classifier';
import { checkEligibility, type SourceMetadata } from './eligibility';
import { classifyPosting } from './classifier';
import { recomputePosting } from './recompute';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    graduation: '2029-05',
    grad_window: ['2028-11', '2029-06'],
    current_class_year: 'junior',
    work_auth: 'f1_opt_cpt',
    requires_sponsorship: true,
    target_categories: ['swe', 'quant', 'ml'],
    locations: ['US'],
    excluded_companies: [],
    tiers: {},
    contacts: {},
    ...overrides,
  };
}

function makePosting(overrides: Partial<FeedPosting> & { id: string }): FeedPosting {
  return {
    company: 'TestCo',
    company_slug: 'testco',
    title: 'Software Engineering Intern',
    location: 'New York, NY',
    locations: ['New York, NY'],
    url: 'https://boards.greenhouse.io/testco/jobs/123',
    source: 'greenhouse',
    source_job_id: '123',
    ats: 'greenhouse',
    posted_at: '2026-09-15T00:00:00Z',
    first_seen_at: '2026-09-15T00:00:00Z',
    last_seen_at: '2026-10-01T00:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

const f1Profile = makeProfile({ work_auth: 'f1_opt_cpt', requires_sponsorship: true });
const h1bProfile = makeProfile({ work_auth: 'h1b', requires_sponsorship: true });
const citizenProfile = makeProfile({ work_auth: 'us_citizen', requires_sponsorship: false });

// ─── Co-op term classification ───────────────────────────────

describe('term-classifier — co-op patterns', () => {
  it('classifies "Software Engineering Co-op" as co_op', () => {
    const result = classifyTerm('Software Engineering Co-op', null, null);
    expect(result.term).toBe('co_op');
    expect(result.confidence).toBe('explicit');
    expect(result.matched).toContain('co-op');
  });

  it('classifies "Co-Op Intern" as co_op', () => {
    const result = classifyTerm('Co-Op Intern - Engineering', null, null);
    expect(result.term).toBe('co_op');
    expect(result.confidence).toBe('explicit');
  });

  it('classifies "Coop Student" as co_op', () => {
    const result = classifyTerm('Engineering Coop Student', null, null);
    expect(result.term).toBe('co_op');
    expect(result.confidence).toBe('explicit');
  });

  it('classifies "Co-op Program" as co_op', () => {
    const result = classifyTerm('Software Co-op Program', null, null);
    expect(result.term).toBe('co_op');
    expect(result.confidence).toBe('explicit');
  });

  it('finds co-op in description when not in title', () => {
    const result = classifyTerm(
      'Engineering Intern',
      'This is a cooperative education program with flexible dates.',
      null,
    );
    expect(result.term).toBe('co_op');
    expect(result.confidence).toBe('explicit');
  });

  it('explicit season+year in title takes priority over co-op in description', () => {
    const result = classifyTerm(
      'SWE Intern - Summer 2027',
      'Also available as a co-op position.',
      null,
    );
    expect(result.term).toBe('summer_2027');
  });

  it('co-op in title takes priority over year_round in description', () => {
    const result = classifyTerm(
      'Software Co-op Intern',
      'This is a year-round opportunity.',
      null,
    );
    expect(result.term).toBe('co_op');
  });
});

// ─── New grad pattern additions ─────────────────────────────

describe('term-classifier — expanded new_grad patterns', () => {
  it('detects "apprenticeship" as new_grad', () => {
    const result = classifyTerm('Engineering Apprenticeship', null, null);
    expect(result.term).toBe('new_grad');
    expect(result.confidence).toBe('explicit');
  });

  it('detects "apprentice" as new_grad', () => {
    const result = classifyTerm('Software Apprentice', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "campus hire" as new_grad', () => {
    const result = classifyTerm('Software Engineer - Campus Hire', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "campus recruit" as new_grad', () => {
    const result = classifyTerm('Campus Recruit - Engineering', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "campus program" as new_grad', () => {
    const result = classifyTerm('SWE Campus Program', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "university program" as new_grad', () => {
    const result = classifyTerm('CUDA Engineer — University Program', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "university talent" as new_grad', () => {
    const result = classifyTerm('University Talent - Software Developer', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "university hire" as new_grad', () => {
    const result = classifyTerm('University Hire - Backend Engineer', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "university recruit" as new_grad', () => {
    const result = classifyTerm('University Recruit Engineering Program', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "early career" as new_grad', () => {
    const result = classifyTerm('Early Career Software Engineer', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "early talent" as new_grad', () => {
    const result = classifyTerm('Early Talent - Data Scientist', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "early in career" as new_grad', () => {
    const result = classifyTerm(
      'Engineer I',
      'Ideal for those early in career with 0-2 years of experience.',
      null,
    );
    expect(result.term).toBe('new_grad');
  });

  it('detects "undergraduate" as new_grad', () => {
    const result = classifyTerm('Undergraduate Research Intern', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "rotational program" as new_grad', () => {
    const result = classifyTerm('Technology Rotational Program', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "rotational analyst" as new_grad', () => {
    const result = classifyTerm('Rotational Analyst - Finance Technology', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "analyst program" as new_grad', () => {
    const result = classifyTerm('Technology Analyst Program', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "Summer Associate" as new_grad (seasonal program)', () => {
    const result = classifyTerm('Summer Associate - Investment Banking', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('detects "Fall Analyst" as new_grad (seasonal program)', () => {
    const result = classifyTerm('Fall Analyst - Technology Division', null, null);
    expect(result.term).toBe('new_grad');
  });

  it('explicit "Summer 2027" takes priority over "analyst program" match', () => {
    const result = classifyTerm('Technology Analyst Program - Summer 2027', null, null);
    expect(result.term).toBe('summer_2027');
  });
});

// ─── Category classifier with Simplify fallback ────────────

describe('category-classifier — Simplify metadata fallback', () => {
  it('title match still takes priority over Simplify category', () => {
    const result = classifyCategory(
      'Machine Learning Engineer Intern',
      null,
      'Software Engineering',
    );
    expect(result.category).toBe('ml');
    expect(result.matched_in).toBe('title');
  });

  it('description match takes priority over Simplify category', () => {
    const result = classifyCategory(
      'Summer 2027 Intern',
      'Work on deep learning models in our AI research lab.',
      'Software Engineering',
    );
    expect(result.category).toBe('ml');
    expect(result.matched_in).toBe('description');
  });

  it('uses Simplify category when title and description have no match', () => {
    const result = classifyCategory(
      'Program Coordinator',
      null,
      'Software Engineering',
    );
    expect(result.category).toBe('swe');
    expect(result.matched_rule).toBe('simplify:Software Engineering');
    expect(result.matched_in).toBeNull();
  });

  it('maps "AI/ML" to ml', () => {
    const result = classifyCategory('Policy Advisor', null, 'AI/ML');
    expect(result.category).toBe('ml');
  });

  it('maps "Quantitative Finance" to quant', () => {
    const result = classifyCategory('Analyst', null, 'Quantitative Finance');
    expect(result.category).toBe('quant');
  });

  it('maps "Hardware Engineering" to hardware', () => {
    const result = classifyCategory('Design Intern', null, 'Hardware Engineering');
    expect(result.category).toBe('hardware');
  });

  it('maps "Data Science" to ml', () => {
    const result = classifyCategory('Analytics Intern', null, 'Data Science');
    expect(result.category).toBe('ml');
  });

  it('maps "Embedded Systems" to hardware', () => {
    const result = classifyCategory('Systems Intern', null, 'Embedded Systems');
    expect(result.category).toBe('hardware');
  });

  it('returns other for unknown Simplify category', () => {
    const result = classifyCategory('Business Intern', null, 'Product Management');
    expect(result.category).toBe('other');
    expect(result.matched_rule).toBeNull();
  });

  it('returns other when no Simplify category provided', () => {
    const result = classifyCategory('Business Intern', null);
    expect(result.category).toBe('other');
  });

  it('returns other when Simplify category is undefined', () => {
    const result = classifyCategory('Business Intern', null, undefined);
    expect(result.category).toBe('other');
  });
});

// ─── Eligibility with source_metadata ───────────────────────

describe('eligibility — source_metadata sponsorship (preliminary signal)', () => {
  describe('without description (metadata used)', () => {
    it('"Offers Sponsorship" → eligible for F-1', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        f1Profile,
        { sponsorship: 'Offers Sponsorship' },
      );
      expect(result.verdict).toBe('eligible');
      expect(result.flags[0]!.type).toBe('eligible_sponsorship');
      expect(result.flags[0]!.matched_sentence).toContain('Simplify');
    });

    it('"Offers Sponsorship" → eligible for H-1B', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        h1bProfile,
        { sponsorship: 'Offers Sponsorship' },
      );
      expect(result.verdict).toBe('eligible');
    });

    it('"Doesn\'t Offer Sponsorship" → ineligible for H-1B', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        h1bProfile,
        { sponsorship: "Doesn't Offer Sponsorship" },
      );
      expect(result.verdict).toBe('ineligible');
      expect(result.flags[0]!.type).toBe('no_sponsorship');
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('"Doesn\'t Offer Sponsorship" → unclear for F-1 (no_sponsorship skip)', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        f1Profile,
        { sponsorship: "Doesn't Offer Sponsorship" },
      );
      expect(result.verdict).toBe('unclear');
    });

    it('"U.S. Citizenship is Required" → ineligible for F-1', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        f1Profile,
        { sponsorship: 'U.S. Citizenship is Required' },
      );
      expect(result.verdict).toBe('ineligible');
      expect(result.flags[0]!.type).toBe('citizenship_required');
    });

    it('"U.S. Citizenship is Required" → ineligible for H-1B', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        h1bProfile,
        { sponsorship: 'U.S. Citizenship is Required' },
      );
      expect(result.verdict).toBe('ineligible');
    });

    it('metadata skipped for US citizen', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        citizenProfile,
        { sponsorship: "Doesn't Offer Sponsorship" },
      );
      expect(result.verdict).toBe('unclear');
    });

    it('no sponsorship field in metadata → unclear', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        f1Profile,
        { category: 'Software Engineering' },
      );
      expect(result.verdict).toBe('unclear');
    });

    it('unknown sponsorship string → unclear', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        f1Profile,
        { sponsorship: 'Maybe Sponsors' },
      );
      expect(result.verdict).toBe('unclear');
    });
  });

  describe('description overrides metadata', () => {
    it('description "we sponsor visas" overrides metadata "Doesn\'t Offer Sponsorship"', () => {
      const result = checkEligibility(
        'Intern',
        'We sponsor work visas for qualified candidates.',
        ['NYC'],
        h1bProfile,
        { sponsorship: "Doesn't Offer Sponsorship" },
      );
      expect(result.verdict).toBe('eligible');
    });

    it('description "unable to sponsor" overrides metadata "Offers Sponsorship"', () => {
      const result = checkEligibility(
        'Intern',
        'We are unable to sponsor work visas at this time.',
        ['NYC'],
        h1bProfile,
        { sponsorship: 'Offers Sponsorship' },
      );
      expect(result.verdict).toBe('ineligible');
    });

    it('description-based verdict used even when metadata present', () => {
      const result = checkEligibility(
        'Intern',
        'Must be a U.S. citizen for government contract.',
        ['NYC'],
        f1Profile,
        { sponsorship: 'Offers Sponsorship' },
      );
      expect(result.verdict).toBe('ineligible');
      expect(result.flags.some((f) => f.type === 'citizenship_required')).toBe(true);
    });

    it('unclear description + positive metadata → unclear (description present = metadata ignored)', () => {
      const result = checkEligibility(
        'Intern',
        'Great opportunity for learning and growth.',
        ['NYC'],
        f1Profile,
        { sponsorship: 'Offers Sponsorship' },
      );
      expect(result.verdict).toBe('unclear');
    });
  });

  describe('ineligible from metadata always has reasons', () => {
    it('metadata-based ineligible has non-empty reasons', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        h1bProfile,
        { sponsorship: "Doesn't Offer Sponsorship" },
      );
      expect(result.verdict).toBe('ineligible');
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons[0]).toContain('matched:');
    });

    it('citizenship metadata has non-empty reasons', () => {
      const result = checkEligibility(
        'Intern',
        null,
        ['NYC'],
        f1Profile,
        { sponsorship: 'U.S. Citizenship is Required' },
      );
      expect(result.verdict).toBe('ineligible');
      expect(result.reasons.length).toBeGreaterThan(0);
    });
  });
});

// ─── classifyPosting integration with source_metadata ───────

describe('classifyPosting — source_metadata integration', () => {
  it('passes source_metadata.category to category classifier', () => {
    const posting = makePosting({
      id: 'p1',
      title: 'Program Coordinator',
      source_metadata: { category: 'Software Engineering' },
    });
    const result = classifyPosting(posting, null, f1Profile);
    expect(result.category.category).toBe('swe');
    expect(result.category.matched_rule).toBe('simplify:Software Engineering');
  });

  it('passes source_metadata.sponsorship to eligibility checker', () => {
    const posting = makePosting({
      id: 'p1',
      title: 'Intern',
      source_metadata: { sponsorship: 'Offers Sponsorship' },
    });
    const result = classifyPosting(posting, null, f1Profile);
    expect(result.eligibility.verdict).toBe('eligible');
  });

  it('works without source_metadata (backward compatibility)', () => {
    const posting = makePosting({ id: 'p1', title: 'SWE Intern - Summer 2027' });
    const result = classifyPosting(posting, null, f1Profile);
    expect(result.term.term).toBe('summer_2027');
    expect(result.category.category).toBe('swe');
    expect(result.eligibility.verdict).toBe('unclear');
  });
});

// ─── Full lifecycle: metadata → description override ────────

describe('source_metadata lifecycle — DB integration', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(() => {
    db.close();
  });

  it('metadata gives preliminary verdict, description overrides', () => {
    const posting = makePosting({
      id: 'lifecycle1',
      title: 'SWE Intern',
      source_metadata: { sponsorship: "Doesn't Offer Sponsorship" },
    });

    db.run(
      `INSERT INTO postings_cache (id, data, first_seen_at, synced_at)
       VALUES (?, ?, ?, ?)`,
      ['lifecycle1', JSON.stringify(posting), posting.first_seen_at, new Date().toISOString()],
    );

    const now = new Date(posting.first_seen_at);

    const before = recomputePosting(db, 'lifecycle1', h1bProfile, now);
    expect(before).not.toBeNull();
    expect(before!.classification.eligibility.verdict).toBe('ineligible');
    expect(before!.score.score).toBeLessThanOrEqual(5);

    db.run(
      'UPDATE postings_cache SET description = ? WHERE id = ?',
      ['We sponsor work visas for qualified candidates. Join our team!', 'lifecycle1'],
    );

    const after = recomputePosting(db, 'lifecycle1', h1bProfile, now);
    expect(after).not.toBeNull();
    expect(after!.classification.eligibility.verdict).toBe('eligible');
    expect(after!.score.score).toBeGreaterThan(5);
    expect(after!.score.breakdown.eligibility).toBe(20);
  });

  it('F-1 ignores no_sponsorship metadata, then description with hard block → ineligible', () => {
    const posting = makePosting({
      id: 'lifecycle2',
      title: 'SWE Intern',
      source_metadata: { sponsorship: "Doesn't Offer Sponsorship" },
    });

    db.run(
      `INSERT INTO postings_cache (id, data, first_seen_at, synced_at)
       VALUES (?, ?, ?, ?)`,
      ['lifecycle2', JSON.stringify(posting), posting.first_seen_at, new Date().toISOString()],
    );

    const now = new Date(posting.first_seen_at);

    const before = recomputePosting(db, 'lifecycle2', f1Profile, now);
    expect(before!.classification.eligibility.verdict).toBe('unclear');
    expect(before!.score.score).toBeGreaterThan(5);

    db.run(
      'UPDATE postings_cache SET description = ? WHERE id = ?',
      ['Must be a U.S. citizen for this government contract.', 'lifecycle2'],
    );

    const after = recomputePosting(db, 'lifecycle2', f1Profile, now);
    expect(after!.classification.eligibility.verdict).toBe('ineligible');
    expect(after!.score.score).toBeLessThanOrEqual(5);
  });

  it('category metadata used when title/description give no match', () => {
    const posting = makePosting({
      id: 'cat-meta1',
      title: 'Coordinator',
      source_metadata: { category: 'AI/ML' },
    });

    db.run(
      `INSERT INTO postings_cache (id, data, first_seen_at, synced_at)
       VALUES (?, ?, ?, ?)`,
      ['cat-meta1', JSON.stringify(posting), posting.first_seen_at, new Date().toISOString()],
    );

    const now = new Date(posting.first_seen_at);
    const result = recomputePosting(db, 'cat-meta1', f1Profile, now);
    expect(result!.classification.category.category).toBe('ml');
  });
});
