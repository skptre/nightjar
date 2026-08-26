import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NightjarDB } from '@/db/database';
import type { Profile } from '@/profile/types';
import type { FeedPosting } from '@/sync/feed-sync';
import { classifyTerm } from './term-classifier';
import { classifyCategory } from './category-classifier';
import { checkEligibility } from './eligibility';
import { classifyPosting, classifyAndStore, classifyNewPostings, reclassifyAll } from './classifier';
import fixtures from './fixtures/eligibility-fixtures.json';

type FixtureEntry = {
  id: string;
  company: string;
  description: string;
  expected_verdict_f1: string;
  expected_verdict_h1b: string;
  expected_verdict_citizen: string;
  notes: string;
};

const typedFixtures = fixtures as FixtureEntry[];

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

describe('term-classifier', () => {
  describe('explicit term patterns', () => {
    it('extracts "Summer 2027" from title', () => {
      const result = classifyTerm('Software Engineering Intern — Summer 2027', null, null);
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('explicit');
      expect(result.matched).toContain('summer');
    });

    it('extracts "Fall 2026" from title', () => {
      const result = classifyTerm('Data Science Intern - Fall 2026', null, null);
      expect(result.term).toBe('fall_2026');
      expect(result.confidence).toBe('explicit');
    });

    it('extracts "Winter 2027" from title', () => {
      const result = classifyTerm('ML Intern, Winter 2027', null, null);
      expect(result.term).toBe('winter_2027');
      expect(result.confidence).toBe('explicit');
    });

    it('extracts "Spring 2027" from title', () => {
      const result = classifyTerm('Intern - Spring 2027', null, null);
      expect(result.term).toBe('spring_2027');
      expect(result.confidence).toBe('explicit');
    });

    it('handles reversed order: "2027 Summer"', () => {
      const result = classifyTerm('2027 Summer Internship - SWE', null, null);
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('explicit');
    });

    it('handles short year: "Summer \'27"', () => {
      const result = classifyTerm("SWE Intern - Summer '27", null, null);
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('explicit');
    });

    it('handles "Autumn 2026" as fall', () => {
      const result = classifyTerm('Intern, Autumn 2026', null, null);
      expect(result.term).toBe('fall_2026');
      expect(result.confidence).toBe('explicit');
    });

    it('extracts term from description when not in title', () => {
      const result = classifyTerm(
        'Software Engineering Intern',
        'Join us for our Summer 2027 internship program in NYC.',
        null,
      );
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('explicit');
    });

    it('prefers title over description', () => {
      const result = classifyTerm(
        'Intern - Fall 2026',
        'Also hiring for Summer 2027 program.',
        null,
      );
      expect(result.term).toBe('fall_2026');
    });
  });

  describe('new grad patterns', () => {
    it('detects "New Grad" in title', () => {
      const result = classifyTerm('Software Engineer, New Grad', null, null);
      expect(result.term).toBe('new_grad');
      expect(result.confidence).toBe('explicit');
    });

    it('detects "New Graduate" in title', () => {
      const result = classifyTerm('New Graduate SWE Position', null, null);
      expect(result.term).toBe('new_grad');
    });

    it('detects "Entry Level" in title', () => {
      const result = classifyTerm('Entry Level Software Developer', null, null);
      expect(result.term).toBe('new_grad');
    });

    it('detects "entry-level" with hyphen', () => {
      const result = classifyTerm('Entry-Level Data Engineer', null, null);
      expect(result.term).toBe('new_grad');
    });

    it('detects "Recent Graduate" in description', () => {
      const result = classifyTerm(
        'Software Engineer I',
        'This role is ideal for recent graduates starting their career.',
        null,
      );
      expect(result.term).toBe('new_grad');
    });
  });

  describe('year-round patterns', () => {
    it('detects "year-round" intern', () => {
      const result = classifyTerm('Year-Round Software Engineering Intern', null, null);
      expect(result.term).toBe('year_round');
      expect(result.confidence).toBe('explicit');
    });

    it('detects "ongoing intern" in description', () => {
      const result = classifyTerm(
        'Engineering Intern',
        'This is an ongoing internship with flexible dates.',
        null,
      );
      expect(result.term).toBe('year_round');
    });

    it('detects "part-time intern"', () => {
      const result = classifyTerm('Part-Time Intern, Engineering', null, null);
      expect(result.term).toBe('year_round');
    });
  });

  describe('inferred from posted date', () => {
    it('infers summer next year for September posting', () => {
      const result = classifyTerm('Software Intern', null, '2026-09-15T00:00:00Z');
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('inferred');
      expect(result.matched).toBeNull();
    });

    it('infers summer same year for January posting', () => {
      const result = classifyTerm('Engineering Intern', null, '2027-01-15T00:00:00Z');
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('inferred');
    });

    it('infers summer same year for March posting', () => {
      const result = classifyTerm('SWE Intern', null, '2027-03-01T00:00:00Z');
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('inferred');
    });

    it('infers summer for May posting (current season)', () => {
      const result = classifyTerm('Developer Intern', null, '2027-05-15T00:00:00Z');
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('inferred');
    });

    it('infers summer next year for December posting', () => {
      const result = classifyTerm('Intern', null, '2026-12-01T00:00:00Z');
      expect(result.term).toBe('summer_2027');
      expect(result.confidence).toBe('inferred');
    });
  });

  describe('unknown', () => {
    it('returns unknown when nothing matches', () => {
      const result = classifyTerm('Associate', null, null);
      expect(result.term).toBe('unknown');
      expect(result.confidence).toBe('inferred');
    });
  });
});

describe('category-classifier', () => {
  describe('title matching', () => {
    it('classifies "Software Engineering Intern" as swe', () => {
      const result = classifyCategory('Software Engineering Intern - Summer 2027', null);
      expect(result.category).toBe('swe');
      expect(result.matched_in).toBe('title');
    });

    it('classifies "Quantitative Researcher Intern" as quant', () => {
      const result = classifyCategory('Quantitative Researcher Intern', null);
      expect(result.category).toBe('quant');
      expect(result.matched_in).toBe('title');
    });

    it('classifies "Machine Learning Engineer" as ml', () => {
      const result = classifyCategory('Machine Learning Engineer Intern', null);
      expect(result.category).toBe('ml');
      expect(result.matched_in).toBe('title');
    });

    it('classifies "Hardware Engineer Intern" as hardware', () => {
      const result = classifyCategory('Hardware Engineer Intern', null);
      expect(result.category).toBe('hardware');
      expect(result.matched_in).toBe('title');
    });

    it('classifies "Frontend Engineer" as swe', () => {
      const result = classifyCategory('Frontend Engineer Intern', null);
      expect(result.category).toBe('swe');
    });

    it('classifies "Trading Intern" as quant', () => {
      const result = classifyCategory('Trading Intern', null);
      expect(result.category).toBe('quant');
    });

    it('classifies "Data Scientist Intern" as ml', () => {
      const result = classifyCategory('Data Scientist Intern', null);
      expect(result.category).toBe('ml');
    });

    it('classifies "FPGA Design Intern" as hardware', () => {
      const result = classifyCategory('FPGA Design Intern', null);
      expect(result.category).toBe('hardware');
    });

    it('classifies "Embedded Software Engineer" as hardware', () => {
      const result = classifyCategory('Embedded Software Engineer Intern', null);
      expect(result.category).toBe('hardware');
    });

    it('classifies "DevOps Engineer" as swe', () => {
      const result = classifyCategory('DevOps Engineer Intern', null);
      expect(result.category).toBe('swe');
    });

    it('classifies "SRE Intern" as swe', () => {
      const result = classifyCategory('Site Reliability Engineering Intern', null);
      expect(result.category).toBe('swe');
    });

    it('classifies "Research Scientist" as ml', () => {
      const result = classifyCategory('Research Scientist Intern', null);
      expect(result.category).toBe('ml');
    });
  });

  describe('description fallback', () => {
    it('falls back to description when title has no match', () => {
      const result = classifyCategory(
        'Summer 2027 Intern',
        'Work on machine learning models and deploy them to production.',
      );
      expect(result.category).toBe('ml');
      expect(result.matched_in).toBe('description');
    });

    it('title match takes priority over description', () => {
      const result = classifyCategory(
        'Trading Intern',
        'You will build software engineering tools for the trading desk.',
      );
      expect(result.category).toBe('quant');
      expect(result.matched_in).toBe('title');
    });
  });

  describe('priority ordering', () => {
    it('quant matches before swe for "Trading Systems Engineer"', () => {
      const result = classifyCategory('Trading Systems Engineer Intern', null);
      expect(result.category).toBe('quant');
    });

    it('ml matches before swe for "ML Engineer"', () => {
      const result = classifyCategory('ML Engineer Intern', null);
      expect(result.category).toBe('ml');
    });

    it('hardware matches before swe for "Firmware Engineer"', () => {
      const result = classifyCategory('Firmware Engineer Intern', null);
      expect(result.category).toBe('hardware');
    });
  });

  describe('other category', () => {
    it('returns other for unrecognized titles', () => {
      const result = classifyCategory('Marketing Intern', null);
      expect(result.category).toBe('other');
      expect(result.matched_rule).toBeNull();
      expect(result.matched_in).toBeNull();
    });

    it('returns other for "Product Manager Intern"', () => {
      const result = classifyCategory('Product Manager Intern', null);
      expect(result.category).toBe('other');
    });
  });

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      const result = classifyCategory('SOFTWARE ENGINEERING INTERN', null);
      expect(result.category).toBe('swe');
    });

    it('matches mixed case', () => {
      const result = classifyCategory('Machine Learning intern', null);
      expect(result.category).toBe('ml');
    });
  });
});

describe('eligibility — hard blocks (F-1 profile)', () => {
  it('flags "must be a U.S. citizen" as ineligible', () => {
    const result = checkEligibility(
      'SWE Intern',
      'Candidates must be a U.S. citizen or permanent resident.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.length).toBeGreaterThan(0);
    expect(result.flags[0]!.type).toBe('citizenship_required');
    expect(result.flags[0]!.matched_sentence).toContain('U.S. citizen');
  });

  it('flags TS/SCI clearance requirement', () => {
    const result = checkEligibility(
      'Intern',
      'Active TS/SCI clearance required for this role.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.some((f) => f.type === 'clearance_required')).toBe(true);
  });

  it('flags ITAR restrictions', () => {
    const result = checkEligibility(
      'Intern',
      'This position is subject to ITAR regulations. Must be a U.S. Person.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.some((f) => f.type === 'itar_ear')).toBe(true);
  });

  it('flags export control requirements', () => {
    const result = checkEligibility(
      'Intern',
      'Due to export control regulations, this role requires U.S. citizenship.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('flags "International Traffic in Arms Regulations"', () => {
    const result = checkEligibility(
      'Intern',
      'This position is governed by International Traffic in Arms Regulations (ITAR).',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('flags "only U.S. citizens"', () => {
    const result = checkEligibility(
      'Intern',
      'Due to government contracts, only U.S. citizens may apply.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('flags "must be a U.S. Person as defined"', () => {
    const result = checkEligibility(
      'Intern',
      'U.S. Person(s) as defined by 22 CFR 120.15 are eligible.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('flags "security clearance required"', () => {
    const result = checkEligibility(
      'Intern',
      'Candidates must hold or obtain a security clearance.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
  });
});

describe('eligibility — no_sponsorship with F-1 profile (should be unclear)', () => {
  it('"unable to sponsor" → unclear for F-1', () => {
    const result = checkEligibility(
      'SWE Intern',
      'We are unable to sponsor work visas at this time.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"does not sponsor" → unclear for F-1', () => {
    const result = checkEligibility(
      'SWE Intern',
      'This company does not sponsor employment visas.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"no visa sponsorship" → unclear for F-1', () => {
    const result = checkEligibility(
      'Intern',
      'No visa sponsorship is available for this position.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"will not sponsor" → unclear for F-1', () => {
    const result = checkEligibility(
      'Intern',
      'The company will not sponsor work authorization for this role.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"without the need for sponsorship" → unclear for F-1', () => {
    const result = checkEligibility(
      'Intern',
      'Must be authorized to work in the US without the need for sponsorship.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"must not require sponsorship" → unclear for F-1', () => {
    const result = checkEligibility(
      'Intern',
      'Applicants must not require visa sponsorship now or in the future.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"cannot sponsor" → unclear for F-1', () => {
    const result = checkEligibility(
      'Intern',
      'We cannot sponsor visas for this position.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"this position is not eligible for visa sponsorship" → unclear for F-1', () => {
    const result = checkEligibility(
      'SWE Intern',
      'Please note that this position is not eligible for visa sponsorship.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"visa sponsorship is not available" → unclear for F-1', () => {
    const result = checkEligibility(
      'SWE Intern',
      'Visa sponsorship is not available for this role.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"must possess unrestricted work authorization" → unclear for F-1', () => {
    const result = checkEligibility(
      'SWE Intern',
      'Candidates must possess unrestricted work authorization in the US.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });
});

describe('eligibility — no_sponsorship with H-1B profile (should be ineligible)', () => {
  it('"unable to sponsor" → ineligible for H-1B', () => {
    const result = checkEligibility(
      'SWE Intern',
      'We are unable to sponsor work visas at this time.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.some((f) => f.type === 'no_sponsorship')).toBe(true);
  });

  it('"does not sponsor" → ineligible for H-1B', () => {
    const result = checkEligibility(
      'SWE Intern',
      'This company does not sponsor employment visas.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('"no visa sponsorship" → ineligible for H-1B', () => {
    const result = checkEligibility(
      'Intern',
      'No visa sponsorship is available for this position.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('"will not sponsor" → ineligible for H-1B', () => {
    const result = checkEligibility(
      'Intern',
      'The company will not sponsor work authorization for this role.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('"cannot sponsor" → ineligible for H-1B', () => {
    const result = checkEligibility(
      'Intern',
      'We cannot sponsor visas for this position.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('"must not require sponsorship" → ineligible for H-1B', () => {
    const result = checkEligibility(
      'Intern',
      'Applicants must not require visa sponsorship now or in the future.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('ineligible');
  });
});

describe('eligibility — US citizen profile (all sponsorship checks skipped)', () => {
  it('skips all sponsorship checks for US citizen', () => {
    const result = checkEligibility(
      'Intern',
      'We are unable to sponsor work visas at this time. Must be a U.S. citizen.',
      ['NYC'],
      citizenProfile,
    );
    expect(result.verdict).toBe('unclear');
    expect(result.flags).toHaveLength(0);
  });

  it('skips ITAR for US citizen', () => {
    const result = checkEligibility(
      'Intern',
      'This position is subject to ITAR regulations.',
      ['NYC'],
      citizenProfile,
    );
    expect(result.verdict).toBe('unclear');
  });
});

describe('eligibility — positive sponsorship signals', () => {
  it('"we sponsor work visas" → eligible for F-1', () => {
    const result = checkEligibility(
      'Intern',
      'We sponsor work visas for qualified candidates. Great benefits included.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.flags.some((f) => f.type === 'eligible_sponsorship')).toBe(true);
  });

  it('"we sponsor work visas" → eligible for H-1B', () => {
    const result = checkEligibility(
      'Intern',
      'We sponsor work visas for qualified candidates.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('eligible');
  });

  it('"visa sponsorship is available" → eligible', () => {
    const result = checkEligibility(
      'Intern',
      'Visa sponsorship is available for this position.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('eligible');
  });

  it('"will sponsor qualified candidates" → eligible', () => {
    const result = checkEligibility(
      'Intern',
      'We will sponsor qualified candidates for work visas.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('eligible');
  });

  it('"H-1B sponsorship available" → eligible', () => {
    const result = checkEligibility(
      'Intern',
      'H-1B sponsorship is available for this role.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('eligible');
  });

  it('positive signal skipped for US citizen → unclear', () => {
    const result = checkEligibility(
      'Intern',
      'We sponsor work visas for qualified candidates.',
      ['NYC'],
      citizenProfile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('hard block overrides positive signal → ineligible', () => {
    const result = checkEligibility(
      'Intern',
      'We sponsor work visas. However, U.S. citizenship is required for this role.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
  });
});

describe('eligibility — neutral phrases (never trigger ineligible)', () => {
  it('"must be authorized to work" alone → unclear', () => {
    const result = checkEligibility(
      'Intern',
      'Must be authorized to work in the United States.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"legally authorized to work" alone → unclear', () => {
    const result = checkEligibility(
      'Intern',
      'Candidates must be legally authorized to work in the United States.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('"proof of eligibility to work" alone → unclear', () => {
    const result = checkEligibility(
      'Intern',
      'Proof of eligibility to work in the United States is required.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('neutral phrases alone → unclear for H-1B too', () => {
    const result = checkEligibility(
      'Intern',
      'Must be authorized to work in the United States.',
      ['NYC'],
      h1bProfile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('does NOT false-positive on "equal opportunity employer"', () => {
    const result = checkEligibility(
      'Intern',
      'We are an equal opportunity employer. All qualified applicants will receive consideration.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('does NOT false-positive on "International students welcome"', () => {
    const result = checkEligibility(
      'Intern',
      'International students on F-1 visa are welcome to apply. We support OPT and CPT.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });
});

describe('eligibility — graduation window', () => {
  it('flags when posting requires Class of 2026 and user graduates 2029', () => {
    const profile = makeProfile({ graduation: '2029-05', grad_window: ['2028-11', '2029-06'] });
    const result = checkEligibility(
      'Intern',
      'Open to Class of 2026 students.',
      ['NYC'],
      profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.some((f) => f.type === 'grad_window_mismatch')).toBe(true);
  });

  it('does not flag when user graduation year falls in range', () => {
    const profile = makeProfile({ graduation: '2027-05', grad_window: ['2026-11', '2027-06'] });
    const result = checkEligibility(
      'Intern',
      'Open to Class of 2027 students.',
      ['NYC'],
      profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('flags "graduating by 2026"', () => {
    const profile = makeProfile({ graduation: '2029-05', grad_window: ['2028-11', '2029-06'] });
    const result = checkEligibility(
      'Intern',
      'Must be graduating by 2026 to be eligible.',
      ['NYC'],
      profile,
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('does not flag when no graduation language', () => {
    const result = checkEligibility(
      'Intern',
      'Great opportunity with competitive compensation.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });
});

describe('eligibility — class year', () => {
  it('flags "PhD required" for non-PhD student', () => {
    const profile = makeProfile({ current_class_year: 'junior' });
    const result = checkEligibility(
      'Intern',
      'PhD students only. Must be enrolled in a doctoral program.',
      ['NYC'],
      profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.some((f) => f.type === 'class_year_mismatch')).toBe(true);
  });

  it('does not flag "PhD required" for PhD student', () => {
    const profile = makeProfile({ current_class_year: 'phd', requires_sponsorship: false });
    const result = checkEligibility(
      'Intern',
      'PhD students only.',
      ['NYC'],
      profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('flags "seniors only" for junior student', () => {
    const profile = makeProfile({ current_class_year: 'junior' });
    const result = checkEligibility(
      'Intern',
      'This position is for seniors only.',
      ['NYC'],
      profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.some((f) => f.type === 'class_year_mismatch')).toBe(true);
  });

  it('does not flag "seniors only" for senior student', () => {
    const profile = makeProfile({ current_class_year: 'senior', requires_sponsorship: false });
    const result = checkEligibility(
      'Intern',
      'This position is for seniors only.',
      ['NYC'],
      profile,
    );
    expect(result.verdict).toBe('unclear');
  });
});

describe('eligibility — location', () => {
  it('flags non-US location for US-only user', () => {
    const profile = makeProfile({ locations: ['New York'] });
    const result = checkEligibility(
      'Intern',
      null,
      ['London, UK'],
      profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.some((f) => f.type === 'location_mismatch')).toBe(true);
  });

  it('does not flag US location for US user', () => {
    const profile = makeProfile({ locations: ['US'] });
    const result = checkEligibility(
      'Intern',
      null,
      ['San Francisco, CA'],
      profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('does not flag when user locations empty', () => {
    const profile = makeProfile({ locations: [] });
    const result = checkEligibility(
      'Intern',
      null,
      ['London, UK'],
      profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('does not flag remote positions', () => {
    const profile = makeProfile({ locations: ['US'] });
    const result = checkEligibility(
      'Intern',
      null,
      ['Remote'],
      profile,
    );
    expect(result.verdict).toBe('unclear');
  });
});

describe('eligibility — defaults and invariants', () => {
  it('defaults to unclear with no description', () => {
    const result = checkEligibility(
      'SWE Intern',
      null,
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
    expect(result.reasons).toHaveLength(0);
    expect(result.flags).toHaveLength(0);
  });

  it('defaults to unclear when no patterns match', () => {
    const result = checkEligibility(
      'SWE Intern',
      'Great opportunity to learn and grow. We offer competitive compensation.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('unclear');
  });

  it('every ineligible verdict has a cited sentence', () => {
    const result = checkEligibility(
      'SWE Intern',
      'Must be a U.S. citizen. This role requires security clearance.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
    for (const flag of result.flags) {
      expect(flag.matched_sentence.length).toBeGreaterThan(0);
    }
    for (const reason of result.reasons) {
      expect(reason).toContain('matched:');
    }
  });

  it('accumulates multiple flags', () => {
    const result = checkEligibility(
      'SWE Intern',
      'Must be a U.S. citizen. TS/SCI clearance required.',
      ['NYC'],
      f1Profile,
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.flags.length).toBeGreaterThanOrEqual(2);
  });

  it('ineligible verdict NEVER has empty reasons', () => {
    const descriptions = [
      'Must be a U.S. citizen.',
      'Security clearance required.',
      'Subject to ITAR regulations.',
    ];
    for (const desc of descriptions) {
      const result = checkEligibility('Intern', desc, ['NYC'], f1Profile);
      if (result.verdict === 'ineligible') {
        expect(result.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('eligibility — adversarial cases', () => {
  it('"authorized to work without need for sponsorship" → unclear for F-1, ineligible for H-1B', () => {
    const desc = 'Applicants must be authorized to work in the United States without need for sponsorship now or in the future.';
    const f1Result = checkEligibility('Intern', desc, ['NYC'], f1Profile);
    expect(f1Result.verdict).toBe('unclear');

    const h1bResult = checkEligibility('Intern', desc, ['NYC'], h1bProfile);
    expect(h1bResult.verdict).toBe('ineligible');
  });

  it('"We do not offer immigration sponsorship" → unclear for F-1, ineligible for H-1B', () => {
    const desc = 'At this time, we do not offer immigration sponsorship for this position.';
    const f1Result = checkEligibility('Intern', desc, ['NYC'], f1Profile);
    expect(f1Result.verdict).toBe('unclear');

    const h1bResult = checkEligibility('Intern', desc, ['NYC'], h1bProfile);
    expect(h1bResult.verdict).toBe('ineligible');
  });

  it('"U.S. citizenship required per government contract" → ineligible for all non-citizens', () => {
    const desc = 'U.S. citizenship is required per government contract requirements.';
    const f1Result = checkEligibility('Intern', desc, ['NYC'], f1Profile);
    expect(f1Result.verdict).toBe('ineligible');

    const h1bResult = checkEligibility('Intern', desc, ['NYC'], h1bProfile);
    expect(h1bResult.verdict).toBe('ineligible');

    const citizenResult = checkEligibility('Intern', desc, ['NYC'], citizenProfile);
    expect(citizenResult.verdict).toBe('unclear');
  });

  it('"Must be authorized to work" alone NEVER triggers ineligible', () => {
    const desc = 'Must be authorized to work in the United States.';
    const f1Result = checkEligibility('Intern', desc, ['NYC'], f1Profile);
    expect(f1Result.verdict).not.toBe('ineligible');

    const h1bResult = checkEligibility('Intern', desc, ['NYC'], h1bProfile);
    expect(h1bResult.verdict).not.toBe('ineligible');
  });

  it('requires_sponsorship false skips all sponsorship checks', () => {
    const noSponsor = makeProfile({ requires_sponsorship: false, work_auth: 'other' });
    const result = checkEligibility(
      'Intern',
      'Must be a U.S. citizen. Unable to sponsor. ITAR restricted.',
      ['NYC'],
      noSponsor,
    );
    expect(result.verdict).toBe('unclear');
  });
});

describe('eligibility — fixture suite', () => {
  it(`has at least 30 fixtures`, () => {
    expect(typedFixtures.length).toBeGreaterThanOrEqual(30);
  });

  describe('F-1 profile fixtures', () => {
    for (const fixture of typedFixtures) {
      it(`${fixture.id} (${fixture.company}): expected ${fixture.expected_verdict_f1}`, () => {
        const result = checkEligibility(
          'SWE Intern',
          fixture.description,
          ['New York, NY'],
          f1Profile,
        );
        expect(result.verdict).toBe(fixture.expected_verdict_f1);

        if (result.verdict === 'ineligible') {
          expect(result.reasons.length).toBeGreaterThan(0);
          for (const reason of result.reasons) {
            expect(reason).toContain('matched:');
          }
        }
      });
    }
  });

  describe('H-1B profile fixtures', () => {
    for (const fixture of typedFixtures) {
      it(`${fixture.id} (${fixture.company}): expected ${fixture.expected_verdict_h1b}`, () => {
        const result = checkEligibility(
          'SWE Intern',
          fixture.description,
          ['New York, NY'],
          h1bProfile,
        );
        expect(result.verdict).toBe(fixture.expected_verdict_h1b);

        if (result.verdict === 'ineligible') {
          expect(result.reasons.length).toBeGreaterThan(0);
        }
      });
    }
  });

  describe('US citizen profile fixtures', () => {
    for (const fixture of typedFixtures) {
      it(`${fixture.id} (${fixture.company}): expected ${fixture.expected_verdict_citizen}`, () => {
        const result = checkEligibility(
          'SWE Intern',
          fixture.description,
          ['New York, NY'],
          citizenProfile,
        );
        expect(result.verdict).toBe(fixture.expected_verdict_citizen);
      });
    }
  });
});

describe('classifier orchestrator', () => {
  let db: NightjarDB;

  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
  });

  afterEach(async () => {
    await db.close();
  });

  describe('classifyPosting', () => {
    it('returns all three classification results', () => {
      const posting = makePosting({
        id: 'p1',
        title: 'Software Engineering Intern - Summer 2027',
      });
      const profile = makeProfile();
      const result = classifyPosting(posting, null, profile);

      expect(result.term.term).toBe('summer_2027');
      expect(result.category.category).toBe('swe');
      expect(result.eligibility.verdict).toBe('unclear');
    });

    it('uses description for classification', () => {
      const posting = makePosting({
        id: 'p1',
        title: 'Summer 2027 Intern',
      });
      const description = 'Work on machine learning models. Must be a U.S. citizen.';
      const profile = makeProfile({ requires_sponsorship: true });
      const result = classifyPosting(posting, description, profile);

      expect(result.term.term).toBe('summer_2027');
      expect(result.category.category).toBe('ml');
      expect(result.eligibility.verdict).toBe('ineligible');
    });
  });

  describe('classifyAndStore', () => {
    it('classifies and stores result in database', async () => {
      const posting = makePosting({ id: 'p1', title: 'Trading Intern - Summer 2027' });
      await db.run(
        `INSERT INTO postings_cache (id, data, first_seen_at, synced_at)
         VALUES (?, ?, ?, ?)`,
        ['p1', JSON.stringify(posting), '2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z'],
      );

      const profile = makeProfile();
      const result = await classifyAndStore(db, 'p1', profile);

      expect(result).not.toBeNull();
      expect(result!.term.term).toBe('summer_2027');
      expect(result!.category.category).toBe('quant');

      const row = await db.queryOne<{
        category: string | null;
        term: string | null;
        eligibility: string | null;
      }>(
        'SELECT category, term, eligibility FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      expect(row!.category).toBe('quant');
      expect(row!.term).toBe('summer_2027');
      expect(row!.eligibility).not.toBeNull();
      const eligibility = JSON.parse(row!.eligibility!) as { verdict: string };
      expect(eligibility.verdict).toBe('unclear');
    });

    it('returns null for nonexistent posting', async () => {
      const profile = makeProfile();
      const result = await classifyAndStore(db, 'nonexistent', profile);
      expect(result).toBeNull();
    });

    it('uses description column for eligibility checks — hard block still works for F-1', async () => {
      const posting = makePosting({ id: 'p1', title: 'SWE Intern - Summer 2027' });
      await db.run(
        `INSERT INTO postings_cache (id, data, description, first_seen_at, synced_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          'p1',
          JSON.stringify(posting),
          'Must be a U.S. citizen for this government contract role.',
          '2026-09-15T00:00:00Z',
          '2026-10-01T00:00:00Z',
        ],
      );

      const profile = makeProfile({ requires_sponsorship: true });
      const result = await classifyAndStore(db, 'p1', profile);

      expect(result!.eligibility.verdict).toBe('ineligible');

      const row = await db.queryOne<{ eligibility: string }>(
        'SELECT eligibility FROM postings_cache WHERE id = ?',
        ['p1'],
      );
      const stored = JSON.parse(row!.eligibility) as { verdict: string };
      expect(stored.verdict).toBe('ineligible');
    });

    it('no_sponsorship in description → unclear for F-1 profile', async () => {
      const posting = makePosting({ id: 'p1', title: 'SWE Intern - Summer 2027' });
      await db.run(
        `INSERT INTO postings_cache (id, data, description, first_seen_at, synced_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          'p1',
          JSON.stringify(posting),
          'We do not sponsor employment visas for this position.',
          '2026-09-15T00:00:00Z',
          '2026-10-01T00:00:00Z',
        ],
      );

      const profile = makeProfile({ work_auth: 'f1_opt_cpt', requires_sponsorship: true });
      const result = await classifyAndStore(db, 'p1', profile);

      expect(result!.eligibility.verdict).toBe('unclear');
    });
  });

  describe('classifyNewPostings', () => {
    it('classifies multiple postings in a transaction', async () => {
      const postings = [
        makePosting({ id: 'p1', title: 'ML Engineer Intern - Fall 2026' }),
        makePosting({ id: 'p2', title: 'Hardware Engineer Intern - Summer 2027' }),
        makePosting({ id: 'p3', title: 'Trading Intern - Summer 2027' }),
      ];

      for (const p of postings) {
        await db.run(
          'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
          [p.id, JSON.stringify(p), '2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z'],
        );
      }

      const profile = makeProfile();
      const results = await classifyNewPostings(db, ['p1', 'p2', 'p3'], profile);

      expect(results.size).toBe(3);
      expect(results.get('p1')!.category.category).toBe('ml');
      expect(results.get('p2')!.category.category).toBe('hardware');
      expect(results.get('p3')!.category.category).toBe('quant');
      expect(results.get('p1')!.term.term).toBe('fall_2026');
      expect(results.get('p2')!.term.term).toBe('summer_2027');
      expect(results.get('p3')!.term.term).toBe('summer_2027');

      for (const id of ['p1', 'p2', 'p3']) {
        const row = await db.queryOne<{ category: string; term: string }>(
          'SELECT category, term FROM postings_cache WHERE id = ?',
          [id],
        );
        expect(row!.category).not.toBeNull();
        expect(row!.term).not.toBeNull();
      }
    });

    it('skips nonexistent IDs gracefully', async () => {
      const posting = makePosting({ id: 'p1', title: 'SWE Intern' });
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', JSON.stringify(posting), '2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z'],
      );

      const profile = makeProfile();
      const results = await classifyNewPostings(db, ['p1', 'nonexistent'], profile);

      expect(results.size).toBe(1);
      expect(results.has('p1')).toBe(true);
    });
  });

  describe('reclassifyAll', () => {
    it('reclassifies all open postings', async () => {
      const posting1 = makePosting({ id: 'p1', title: 'SWE Intern - Summer 2027' });
      const posting2 = makePosting({ id: 'p2', title: 'ML Intern - Fall 2026', closed_at: '2026-10-01T00:00:00Z' });
      const posting3 = makePosting({ id: 'p3', title: 'QA Intern' });

      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p1', JSON.stringify(posting1), '2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z'],
      );
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, closed_at, synced_at) VALUES (?, ?, ?, ?, ?)',
        ['p2', JSON.stringify(posting2), '2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'],
      );
      await db.run(
        'INSERT INTO postings_cache (id, data, first_seen_at, synced_at) VALUES (?, ?, ?, ?)',
        ['p3', JSON.stringify(posting3), '2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z'],
      );

      const profile = makeProfile();
      const count = await reclassifyAll(db, profile);

      expect(count).toBe(2);

      const row1 = await db.queryOne<{ category: string }>('SELECT category FROM postings_cache WHERE id = ?', ['p1']);
      expect(row1!.category).toBe('swe');

      const row2 = await db.queryOne<{ category: string | null }>('SELECT category FROM postings_cache WHERE id = ?', ['p2']);
      expect(row2!.category).toBeNull();

      const row3 = await db.queryOne<{ category: string }>('SELECT category FROM postings_cache WHERE id = ?', ['p3']);
      expect(row3!.category).toBe('other');
    });
  });
});
