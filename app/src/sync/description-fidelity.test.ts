import { afterEach, describe, expect, it, vi } from 'vitest';
import job from '../../../poller/tests/fixtures/lever/sectioned_job.json';
import { DescriptionFetcher, htmlToPlaintext } from './description-fetch';

afterEach(() => vi.unstubAllGlobals());

describe('complete source descriptions in client fallback', () => {
  it('preserves sections and inline conditions, excluding scripts and styles', () => {
    expect(htmlToPlaintext('<h2>Required</h2><ul><li>U.S. <b>citizens only</b>.</li>' +
      '<li>Graduating 2028.</li></ul><script>Sponsorship available.</script><style>p{}</style>'))
      .toBe('Required\n\n- U.S. citizens only.\n- Graduating 2028.');
  });

  it('retains plaintext paragraphs and comparisons', () => {
    const text = 'Duties\n\nBuild systems with latency < 5 ms.\n\nRequired\nGraduating 2028.';
    expect(htmlToPlaintext(text)).toBe(text);
  });

  it('retains Lever qualifications, closing restrictions, and salary text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      ...job, description: job.description + '<p>' + 'Flight controls. '.repeat(400) + '</p>',
    }) }));
    const result = await new DescriptionFetcher().fetchOne({
      id: 'lever', url: job.hostedUrl, source: 'lever', source_job_id: job.id, company_slug: 'example',
    });
    expect(result.description).toContain('Required qualifications\n\n- Graduating between');
    expect(result.description).toContain('Preferred qualifications\n\n- Experience with embedded Linux.');
    expect(result.description?.slice(5000)).toContain('This position is open only to U.S. citizens.');
    expect(result.description).toContain('Undergraduates: $30–$40 per hour. Housing stipend is separate.');
    expect(result.description?.match(/Build flight software\./g)).toHaveLength(1);
  });

  it.each([
    ['workday', 'https://acme.wd5.myworkdayjobs.com/External/job/Intern_R123',
      { jobPostingInfo: { jobDescription: '<h2>Required</h2><p>Graduating 2028.</p>' } }],
    ['ashby', 'https://jobs.ashbyhq.com/acme/123',
      { jobs: [{ id: '123', descriptionHtml: '<h2>Required</h2><p>Graduating 2028.</p>' }] }],
    ['smartrecruiters', 'https://jobs.smartrecruiters.com/Acme/123',
      { jobAd: { sections: { qualifications: { title: 'Required', text: '<p>Graduating 2028.</p>' } } } }],
  ])('preserves %s detail structure', async (source, url, data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
    const result = await new DescriptionFetcher().fetchOne({
      id: 'test', source, url, source_job_id: '123', company_slug: 'acme',
    });
    expect(result.description).toBe('Required\n\nGraduating 2028.');
  });
});
