import { describe, expect, it } from 'vitest';
import { classifyCategory } from './category-classifier';
import { matchesRoleSelection } from './role-taxonomy';

describe('work and field classification', () => {
  it('keeps avionics software out of core aerospace engineering', () => {
    const role = classifyCategory('Avionics Software Engineer Intern', null);
    expect(role.category_tags).toEqual(['swe']);
    expect(role.domain_tags).toContain('aerospace');
    expect(matchesRoleSelection(role.category_tags, role.domain_tags, new Set(['aero']), new Set())).toBe(false);
    expect(matchesRoleSelection(role.category_tags, role.domain_tags, new Set(['swe']), new Set(['aerospace']))).toBe(true);
    expect(matchesRoleSelection(role.category_tags, role.domain_tags, new Set(['swe']), new Set(['quant']))).toBe(false);
  });

  it('distinguishes quant developers from quant researchers without losing their field', () => {
    const dev = classifyCategory('Quantitative Developer Intern', null);
    const research = classifyCategory('Quantitative Research Intern', null);
    expect(dev.category_tags).toEqual(['swe']);
    expect(research.category_tags).toEqual(['quant']);
    for (const role of [dev, research]) {
      expect(matchesRoleSelection(role.category_tags, role.domain_tags, new Set(), new Set(['quant']))).toBe(true);
    }
    expect(matchesRoleSelection(research.category_tags, research.domain_tags, new Set(['swe']), new Set(['quant']))).toBe(false);
  });

  it.each([
    ['Software Engineer (Flight Systems) Intern', 'swe', 'aerospace'],
    ['FPGA Engineer - High Frequency Trading Intern', 'hardware', 'quant'],
    ['Mechanical Engineer - Spacecraft Intern', 'mechE', 'aerospace'],
    ['Robotics Software Engineer Intern', 'swe', 'robotics'],
    ['Financial Analyst - Aerospace Intern', 'finance', 'aerospace'],
  ])('separates function and domain in %s', (title, category, domain) => {
    const result = classifyCategory(title, null);
    expect(result.category).toBe(category);
    expect(result.domain_tags).toContain(domain);
  });

  it.each([
    ['Product Management Intern', 'product'],
    ['Information Technology Intern', 'it'],
    ['Marketing Strategy Intern', 'marketing'],
    ['Talent and Recruiting Intern', 'people'],
    ['Contracts Intern - Deals', 'legal'],
    ['Back-End Engineer Intern', 'swe'],
    ['Data Analysis Intern', 'data-ml'],
    ['Technology Consulting Intern', 'consulting'],
    ['Software Engineering Intern', 'swe'],
    ['Gas Turbine Products Engineering Intern', 'mechE'],
  ])('uses independent title evidence for %s despite incorrect source metadata', (title, category) => {
    expect(classifyCategory(title, null, 'AI/ML/Data').category).toBe(category);
  });

  it('does not infer work from boilerplate or lists of acceptable majors', () => {
    const result = classifyCategory('Mechanical Engineering Intern',
      'We are a software company serving aerospace and finance. Applicants may study computer science, electrical engineering or mechanical engineering.');
    expect(result.category_tags).toEqual(['mechE']);
    expect(result.domain_tags).toEqual([]);
  });

  it('uses responsibility evidence for a vague title', () => {
    const result = classifyCategory('Summer Intern',
      'Responsibilities: You will develop flight software for spacecraft.');
    expect(result.category_tags).toEqual(['swe']);
    expect(result.domain_tags).toContain('aerospace');
    expect(result.confidence).toBe('medium');
    expect(result.evidence.some(e => e.source === 'description' && e.text.includes('flight software'))).toBe(true);
  });

  it('does not guess SWE for ambiguous systems, QA, or applications engineering', () => {
    for (const title of ['Systems Engineering Intern', 'Quality Assurance Intern', 'Applications Engineer Intern']) {
      expect(classifyCategory(title, null).category).toBe('other');
    }
  });

  it('matches alternatives within an axis and requires both axes', () => {
    expect(matchesRoleSelection(['hardware'], ['quant'], new Set(['swe', 'hardware']), new Set(['aerospace', 'quant']))).toBe(true);
    expect(matchesRoleSelection(['swe'], [], new Set(['swe']), new Set(['quant']))).toBe(false);
    expect(matchesRoleSelection(['other'], [], new Set(), new Set())).toBe(true);
  });

  it('uses source Quant as field evidence for an explicitly named software role', () => {
    const result = classifyCategory('Software Engineer Intern', null, 'Quant');
    expect(result.category_tags).toEqual(['swe']);
    expect(result.domain_tags).toContain('quant');
    expect(result.evidence).toContainEqual(expect.objectContaining({ axis: 'field', value: 'quant', source: 'source-category' }));
  });

  it.each(['Trading Intern', 'Quantitative Research Intern', 'Quantitative Analyst Intern'])('includes %s when browsing the Quant field', title => {
    expect(classifyCategory(title, null).domain_tags).toContain('quant');
  });

  it('uses a structured department to disambiguate a generic title', () => {
    expect(classifyCategory('Intern', null, undefined, { department: 'Software Engineering - Avionics' }))
      .toMatchObject({ category: 'swe', domain_tags: ['aerospace'], confidence: 'medium' });
  });

  it('does not let a fallback override a standalone title discipline', () => {
    expect(classifyCategory('Aerospace Intern', null, 'Software').category).toBe('aero');
  });

  it.each(['Software Engineering Program Manager Intern', 'Software Engineering Recruiter Intern'])('does not confuse the team with the work in %s', title => {
    expect(classifyCategory(title, null).category_tags).not.toContain('swe');
  });

  it('does not infer a job function from the subject of research', () => {
    expect(classifyCategory('UX Research Intern', null).category_tags).toEqual(['design']);
    expect(classifyCategory('Equity Research Intern', null).category_tags).toEqual(['finance']);
  });

  it.each([
    'We build software for aerospace customers.',
    'Our team develops software for quantitative trading.',
    'You will not develop software or flight systems.',
  ])('does not treat employer activity or negated duties as role evidence: %s', description => {
    expect(classifyCategory('Summer Intern', description).category).toBe('other');
    expect(classifyCategory('Summer Intern', description).domain_tags).toEqual([]);
  });
});
