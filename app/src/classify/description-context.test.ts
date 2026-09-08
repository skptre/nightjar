import { describe, expect, it } from 'vitest';
import { classifyCategory } from './category-classifier';
import { matchesRoleSelection } from './role-taxonomy';

describe('employer field and candidate work remain independent', () => {
  it.each([
    ['We are an aerospace company.', 'aerospace'],
    ['We are a quantitative trading firm.', 'quant'],
    ['Our company is a semiconductor manufacturer.', 'semiconductors'],
  ])('preserves explicit employer field: %s', (company, field) => {
    const result = classifyCategory('Software Engineering Intern',
      `About us\n\n${company}\n\nResponsibilities\n\nDevelop internal software tools.`);
    expect(result.category_tags).toEqual(['swe']);
    expect(result.domain_tags).toContain(field);
    expect(matchesRoleSelection(result.category_tags, result.domain_tags,
      new Set(['swe']), new Set([field]))).toBe(true);
    expect(result.evidence).toContainEqual(expect.objectContaining({
      axis: 'field', source: 'employer', text: company,
    }));
  });

  it.each([
    'We build software for aerospace customers.',
    'We partner with a quantitative trading firm.',
    'We are not an aerospace company.',
    'Our clients include semiconductor manufacturers.',
  ])('does not treat customers, partners, or negation as employer industry: %s', company => {
    expect(classifyCategory('Software Intern', `About us\n\n${company}`).domain_tags).toEqual([]);
  });

  it('does not infer a profession from employer industry', () => {
    const result = classifyCategory('Summer Intern', 'About us\n\nWe are an aerospace company.');
    expect(result.category).toBe('other');
    expect(result.domain_tags).toEqual(['aerospace']);
  });

  it('accepts a named employer self-description without needing an About us heading', () => {
    const result = classifyCategory('Software Intern',
      'Example Capital is a quantitative trading firm.\n\nYou will build internal software.',
      undefined, { company: 'Example Capital' });
    expect(result.category_tags).toEqual(['swe']);
    expect(result.domain_tags).toContain('quant');
  });

  it('does not attribute a different named company to the employer', () => {
    const result = classifyCategory('Software Intern',
      'Another Company is an aerospace company.', undefined, { company: 'Example Capital' });
    expect(result.domain_tags).toEqual([]);
  });

  it('uses duties to specialize a generic research title', () => {
    const result = classifyCategory('Research Intern',
      'Responsibilities\n\nYou will develop machine learning models for satellite imagery.');
    expect(result.category).toBe('data-ml');
    expect(result.domain_tags).toContain('aerospace');
  });

  it('does not turn flight perks into an aerospace field', () => {
    const result = classifyCategory('Office Operations Intern',
      'Responsibilities\n\nYou will book flight tickets and manage office supplies.');
    expect(result.domain_tags).not.toContain('aerospace');
  });

  it('recognizes candidate duties with natural first-person and noun phrasing', () => {
    for (const line of ["You'll be developing software for spacecraft.",
      'Your responsibilities include developing flight software.']) {
      expect(classifyCategory('Summer Intern', `Responsibilities\n\n${line}`))
        .toMatchObject({ category: 'swe', domain_tags: ['aerospace'] });
    }
  });
});
