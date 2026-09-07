import { describe, expect, it } from 'vitest';
import { extractJobDetails } from './extract';
import { compensationLabel } from './pay';
import { classifyCategory } from '../classify/category-classifier';

describe('description patterns reviewed in the recovered backfill', () => {
  it.each([
    ['$23.50/hr to $52.50/hr', '$23.50–52.50/hr'],
    ['The expected pay range is between $23.50 per hour and $52.50 per hour.', '$23.50–52.50/hr'],
    ['The projected compensation range is $53,000.00 to $108,000.00 (annualized USD).', '$53,000–108,000/year'],
  ])('preserves a single advertised range: %s', (text, label) => {
    const details = extractJobDetails(text, { acquisition: 'available' });
    expect(compensationLabel(details.compensation)).toBe(label);
    expect(details.compensation.ranges).toHaveLength(1);
    expect(details.compensation.ranges[0]?.evidence.text).toBe(text);
  });

  it.each([
    'Base pay $30/hour and housing stipend $1,000/month.',
    'Pay $30/hour to $60,000/year depending on employment type.',
    'Pay USD 30/hour to CAD 40/hour depending on location.',
  ])('does not merge separate components, periods or currencies: %s', text => {
    const ranges = extractJobDetails(text).compensation.ranges;
    expect(ranges).toHaveLength(2);
    expect(ranges.every(r => r.min === r.max)).toBe(true);
  });

  it.each([
    ['You Have', 'required'], ['Your Background', 'required'],
    ['Nice If You Have', 'preferred'], ['Preferred Requirements', 'preferred'],
    ['Company Description', 'company'], ['Additional Information', 'other'],
    ["What You'll Achieve", 'responsibilities'], ['Skills You’ll Need To Bring', 'required'],
    ["🔧 What You'll Work On", 'responsibilities'], ["🌵 What You'll Get", 'compensation'],
  ] as const)('recognizes employer section heading %s', (heading, kind) => {
    const text = `${heading}\n\n- Software development experience.`;
    const details = extractJobDetails(text);
    expect(details.sections[kind][0]?.text).toBe('- Software development experience.');
    expect(classifyCategory('Summer Intern', text).category).toBe('other');
  });

  it('does not turn unmarked duty-like qualifications into a profession', () => {
    const text = 'You Have\n\n- Develop software using Python.\n\nNice If You Have\n\n- Design mechanical hardware.';
    expect(classifyCategory('Summer Intern', text).category).toBe('other');
  });
  it('recognizes explicit work in a Job Description section', () => {
    const text = 'Company Description\n\nWe build spacecraft.\n\nJob Description\n\nYou will develop software for medical devices.\n\nQualifications\n\nMechanical engineering degree preferred.';
    const result = classifyCategory('Summer Intern', text);
    expect(result.category).toBe('swe');
    expect(result.domain_tags).toEqual(['healthcare']);
    expect(result.evidence.some(e => e.source === 'description')).toBe(true);
  });
  it('keeps legacy standalone bullet markers attached to their exact original passage', () => {
    const text = 'Qualifications\n\n-\n\nMust be enrolled.\n\n-\n\nMust return to school.';
    const result = extractJobDetails(text);
    expect(result.sections.required.map(e => e.text)).toEqual([
      '-\n\nMust be enrolled.', '-\n\nMust return to school.',
    ]);
    for (const e of result.sections.required) expect(text.slice(e.start, e.end)).toBe(e.text);
  });
});
