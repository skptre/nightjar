import { describe, expect, it } from 'vitest';
import { extractJobDetails } from './extract';

describe('mixed mandatory and preferred requirements preserve their scope', () => {
  it('does not turn a mandatory sentence into a preference because its neighbor is preferred', () => {
    const text = 'Qualifications\n\nMust be enrolled in a degree program. Python experience is preferred.';
    const details = extractJobDetails(text);
    expect(details.sections.required.map(p => p.text)).toEqual(['Must be enrolled in a degree program.']);
    expect(details.sections.preferred.map(p => p.text)).toEqual(['Python experience is preferred.']);
    for (const p of Object.values(details.sections).flat()) expect(text.slice(p.start, p.end)).toBe(p.text);
  });
  it('preserves exceptions within a requirement sentence', () => {
    const text = 'Required qualifications\n\nMust have a degree, unless equivalent experience is accepted. Python preferred.';
    expect(extractJobDetails(text).sections.required[0]?.text)
      .toBe('Must have a degree, unless equivalent experience is accepted.');
  });
  it.each(['Responsibilities and Duties', 'Duties and Responsibilities', 'What You’ll Be Doing'])
  ('recognizes a responsibilities heading: %s', heading => {
    expect(extractJobDetails(`${heading}\n\nFlight software implementation.`)
      .sections.responsibilities.map(p => p.text)).toEqual(['Flight software implementation.']);
  });
  it.each(['Required Skills and Experience', 'Minimum Requirements', 'Education and Experience'])
  ('recognizes a qualifications heading: %s', heading => {
    expect(extractJobDetails(`${heading}\n\nEnrolled in a degree program.`)
      .sections.required.map(p => p.text)).toEqual(['Enrolled in a degree program.']);
  });
});
