import { describe, expect, it } from 'vitest';
import { extractJobDetails } from './extract';
import { compensationLabel } from './pay';
import { assessRequirements, orderByRequirements } from './requirements';
import type { Profile } from '@/profile/types';

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  graduation: '2028-05', grad_window: ['2027-11', '2028-06'], current_class_year: 'unknown',
  work_auth: 'f1_opt_cpt', requires_sponsorship: true, target_categories: ['swe'],
  locations: ['US'], excluded_companies: [], tiers: {}, contacts: {}, ...overrides,
});
const inspect = (text: string, p = profile()) => assessRequirements(extractJobDetails(text,
  { acquisition: 'available' }), p);

describe('faithful description evidence', () => {
  it.each(['Must be a U.S. citizen for this role.', 'This position requires US citizenship.'])
  ('recognizes direct mandatory citizenship language: %s', text => {
    expect(inspect(text).exclude).toBe(true);
  });
  it('separates sections, preserves complete clauses, and keeps exact source offsets', () => {
    const text = "About us\n\nWe build rockets.\n\nWhat you will do\n\n- Build avionics software.\n- Test flight controls.\n\nRequired qualifications\n\n- Must graduate between December 2027 and June 2028.\n\nPreferred qualifications\n\n- Python experience.\n\nWork authorization\n\nU.S. citizenship is required unless an exception is approved.";
    const result = extractJobDetails(text, { acquisition: 'available' });
    expect(result.sections.responsibilities).toHaveLength(2);
    expect(result.sections.required).toHaveLength(1);
    expect(result.sections.preferred).toHaveLength(1);
    expect(result.authorization[0]?.text).toContain('unless an exception is approved');
    for (const e of Object.values(result.sections).flat()) expect(text.slice(e.start, e.end)).toBe(e.text);
    expect(inspect(text).exclude).toBe(false);
  });
  it('does not drop inline headings or continuation lines', () => {
    const text = 'Required qualifications: Must graduate in 2028.\nPreferred qualifications: Python.\n\nAuthorization\n\nWe cannot support CPT or OPT,\nexcept through a university partnership.';
    const result = extractJobDetails(text);
    expect(result.sections.required[0]?.text).toBe('Must graduate in 2028.');
    expect(result.sections.preferred[0]?.text).toBe('Python.');
    expect(inspect(text).exclude).toBe(false);
  });
});

describe('narrow authorization exclusions', () => {
  it.each([
    'U.S. citizenship is required.',
    'Applicants must be U.S. citizens.',
    'This role is open only to US citizens.',
    'We are only able to hire U.S. citizens at this time.',
    'Applicants on F-1 visas are not eligible for this position.',
    'We do not accept candidates using CPT or OPT.',
  ])('excludes only explicit mandatory conflict: %s', text => {
    const result = inspect(text);
    expect(result.exclude).toBe(true);
    expect(result.exclusionEvidence.some(e => e.text === text)).toBe(true);
  });
  it.each([
    'No visa sponsorship is available.',
    'Candidates must be authorized to work in the US.',
    'Do you require sponsorship now or in the future?',
    'U.S. citizenship is not required.',
    'U.S. citizenship is preferred.',
    'Must be a U.S. citizen or lawful permanent resident.',
    'Must be a U.S. person under ITAR, or eligible to obtain required authorizations.',
    'Security clearance is required.',
    'We support CPT and OPT students.',
    'Applicants on STEM OPT are not eligible.',
    'Applicants on OPT are not eligible.',
    'U.S. citizenship is required. Exceptions may be approved.',
    'We do not discriminate based on citizenship or immigration status.',
    '',
  ])('retains cases that do not prove this profile is excluded: %s', text => {
    expect(inspect(text).exclude).toBe(false);
  });
  it('does not confuse a permanent resident with a citizen', () => {
    expect(inspect('US citizens only.', profile({ work_auth: 'permanent_resident', requires_sponsorship: false })).exclude).toBe(true);
    expect(inspect('US citizens only.', profile({ work_auth: 'us_citizen', requires_sponsorship: false })).exclude).toBe(false);
  });
  it('does not interpret missing or stale content as an exclusion', () => {
    expect(assessRequirements(extractJobDetails('US citizens only.', { acquisition: 'stale' }), profile()).exclude).toBe(false);
    expect(assessRequirements(extractJobDetails(null, { acquisition: 'unavailable' }), profile()).exclude).toBe(false);
  });
  it.each([
    'You will build services for US citizens only.',
    'Our customers are US citizens only.',
    'Some positions require US citizenship; this internship does not.',
    'The role does not require US citizenship.',
    'Applicants must be US citizens.\n\nPermanent residents are also eligible.',
    'Citizenship is preferred but not required.\n\nUS citizens only projects exist elsewhere.',
    'CPT students are welcome. We cannot accept OPT candidates.',
    'We cannot sponsor visas. CPT and OPT candidates are welcome.',
    'F-1 candidates are welcome. H-1B applicants are not eligible.',
    'We do not accept H-1B applicants. F-1 students are eligible.',
  ])('does not exclude from unrelated or conflicting context: %s', text => {
    expect(inspect(text).exclude).toBe(false);
  });
  it('uses a known training path without assuming one for a combined F-1 profile', () => {
    expect(inspect('We do not accept OPT candidates.', profile({ authorization_path: 'opt' })).exclude).toBe(true);
    expect(inspect('We do not accept OPT candidates.', profile({ authorization_path: 'cpt' })).exclude).toBe(false);
  });
});

describe('graduation ordering', () => {
  it.each([
    ['Required qualifications\n\nGraduating between December 2027 and June 2028.', '2028-05', false],
    ['Required qualifications\n\nGraduating between December 2027 and June 2028.', '2028-08', true],
    ['Required qualifications\n\nGraduating between December 2027 and June 2028.', '2028', false],
    ['Preferred qualifications\n\nGraduating in 2027.', '2028-05', false],
    ['Must graduate in 2027 or 2028.', '2028-05', false],
    ['Must graduate in 2027 or 2029.', '2028-05', true],
    ['Must graduate by June 2028.', '2028-08', true],
    ['Must graduate after June 2028.', '2028-06', true],
    ['Must be enrolled and return to school after the internship.', '2028-05', false],
    ['Graduation in 2027 is preferred.', '2028-05', false],
  ])('handles %s for %s', (text, graduation, expected) => {
    const result = inspect(text, profile({ graduation }));
    expect(result.outsideGradWindow).toBe(expected);
    expect(result.exclude).toBe(false);
  });
  it('stably partitions grad mismatches and makes excluded postings inspectable', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, assessment: {
      exclude: index === 2, exclusionEvidence: [], outsideGradWindow: index === 0, graduationEvidence: [],
    } }));
    expect(orderByRequirements(rows).map(r => r.id)).toEqual(['b', 'd', 'a']);
    expect(orderByRequirements(rows, true).map(r => r.id)).toEqual(['b', 'c', 'd', 'a']);
  });
});

describe('advertised compensation', () => {
  it.each([
    ['$30–$40 per hour.', 'available', '$30–40/hr'],
    ['Salary: $90,000/year.', 'available', '$90,000/year'],
    ['Salary: $30.', 'available', 'See pay details'],
    ['Compensation\n\nNY: $40/hour.\n\nTX: $30/hour.', 'available', 'See pay details'],
    ['Build software.', 'available', 'Pay not listed'],
    ['', 'unavailable', 'Pay unavailable'],
  ] as const)('formats pay consistently: %s', (text, acquisition, expected) => {
    expect(compensationLabel(extractJobDetails(text, { acquisition }).compensation)).toBe(expected);
  });
  it.each([
    ['$30–$40 per hour.', 30, 40, 'USD', 'hour'],
    ['Pay: $6,000/month.', 6000, 6000, 'USD', 'month'],
    ['Base salary: USD 80,000 to 100,000 per year.', 80000, 100000, 'USD', 'year'],
    ['Compensation: £20–£25/hour.', 20, 25, 'GBP', 'hour'],
    ['Salary: $80k–$100k annually.', 80000, 100000, 'USD', 'year'],
  ])('extracts %s without annualizing', (text, min, max, currency, period) => {
    expect(extractJobDetails(text, { acquisition: 'available' }).compensation.ranges[0])
      .toMatchObject({ min, max, currency, period });
  });
  it('keeps locations and stipends separate', () => {
    const result = extractJobDetails('Compensation\n\nNew York: $40–$50/hour.\n\nAustin: $30–$40/hour.\n\nHousing stipend: $1,000/month.', { acquisition: 'available' });
    expect(result.compensation.ranges).toHaveLength(3);
    expect(result.compensation.ranges[2]?.kind).toBe('stipend');
    expect(result.compensation.ranges[0]?.evidence.text).toContain('New York');
  });
  it('does not classify revenue or unsupported amounts as salary', () => {
    const result = extractJobDetails('About us\n\nWe raised $20 million this year.\n\nResponsibilities\n\nManage a $500 budget.', { acquisition: 'available' });
    expect(result.compensation.ranges).toEqual([]);
  });
  it('does not label an advertised range with missing period as unlisted pay', () => {
    const result = extractJobDetails('Salary range: $30–$40.', { acquisition: 'available' });
    expect(result.compensation.status).toBe('listed');
    expect(result.compensation.ranges).toEqual([]);
  });
  it('preserves the category of each monetary component in a mixed paragraph', () => {
    const result = extractJobDetails('Base pay: $30/hour; housing stipend: $1,000/month.', { acquisition: 'available' });
    expect(result.compensation.ranges.map(p => [p.kind, p.period])).toEqual([['base','hour'], ['stipend','month']]);
  });
  it('keeps structured hourly pay when no description is available', () => {
    const result = extractJobDetails(null, { acquisition: 'unavailable', structuredCompensation: {
      provider: 'lever', data: { salaryRange: { min: 30, max: 40, interval: 'hourly', currency: 'USD' } },
    } });
    expect(result.compensation.status).toBe('listed');
    expect(result.compensation.ranges[0]).toMatchObject({ min: 30, max: 40, period: 'hour', source: 'structured' });
  });
  it('does not expose Ashby compensation marked not for publication', () => {
    expect(extractJobDetails(null, { structuredCompensation: {
      provider: 'ashby', data: { shouldDisplayCompensationOnJobPostings: false, compensation: {
        summaryComponents: [{ minValue: 30, maxValue: 40, interval: '1 HOUR', currencyCode: 'USD', compensationType: 'Salary' }],
      } },
    } }).compensation.ranges).toEqual([]);
  });
  it('preserves advertised structured pay when the source omits its period', () => {
    const result = extractJobDetails('Build software.', { acquisition: 'available', structuredCompensation: {
      provider: 'greenhouse', data: { pay_input_ranges: [{ min_cents: 3000, max_cents: 4000, currency_type: 'USD' }] },
    } });
    expect(result.compensation.status).toBe('listed');
    expect(result.compensation.ranges).toEqual([]);
    expect(compensationLabel(result.compensation)).toBe('See pay details');
  });
  it('distinguishes omitted pay from unavailable details', () => {
    expect(extractJobDetails('Build software.', { acquisition: 'available' }).compensation.status).toBe('not_listed');
    expect(extractJobDetails(null, { acquisition: 'unavailable' }).compensation.status).toBe('unavailable');
    expect(extractJobDetails('Pay is competitive.', { acquisition: 'available' }).compensation.ranges).toEqual([]);
  });
});
