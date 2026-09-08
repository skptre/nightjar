import { expect, it } from 'vitest';
import { matchesGraduationStage } from './opportunity-stage';

const today = new Date('2026-09-08T12:00:00Z');
it('reserves graduate roles for this year or next year graduates', () => {
  const job = { title: 'Software Engineer, New Grad', term: 'new_grad' };
  expect(matchesGraduationStage(job, '2029-05', today)).toBe(false);
  expect(matchesGraduationStage(job, '2028-05', today)).toBe(false);
  expect(matchesGraduationStage(job, '2027-12', today)).toBe(true);
  expect(matchesGraduationStage(job, '2026-05', today)).toBe(true);
  expect(matchesGraduationStage(job, '2029-05', new Date(2028, 0, 1))).toBe(true);
});
it('recognizes graduate titles even before classification or with a seasonal term', () => {
  for (const title of ['New Graduate Engineer — Summer 2027', 'Recent Graduate Analyst', 'Entry-Level Engineer', 'University Graduate Engineer']) {
    expect(matchesGraduationStage({ title, term: 'summer_2027' }, '2029-05', today)).toBe(false);
  }
});
it('keeps internships, co-ops and student programs despite broad cached new-grad labels', () => {
  for (const title of ['Undergraduate Engineering Intern', 'Software Internship', 'Engineering Co-op', 'Summer Analyst', 'Summer Associate']) {
    expect(matchesGraduationStage({ title, term: 'new_grad' }, '2029-05', today)).toBe(true);
  }
});
it('keeps uncertain postings and leaves guests unfiltered', () => {
  expect(matchesGraduationStage({ title: 'Engineering Opportunity', term: null }, '2029-05', today)).toBe(true);
  for (const graduation of [undefined, '', 'invalid']) {
    expect(matchesGraduationStage({ title: 'New Grad Engineer', term: 'new_grad' }, graduation, today)).toBe(true);
  }
});

