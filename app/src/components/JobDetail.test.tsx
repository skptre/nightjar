import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { JobDetail } from './JobDetail';
import type { PostingRowData } from '@/views/Feed/PostingRow';
vi.mock('@/providers/DatabaseProvider', () => ({ useDatabase: () => ({ db: { queryOne: () => new Promise(() => {}) } }) }));
vi.mock('./Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/hooks/useWatchlist', () => ({ useWatchlist: () => [], toggleWatch: vi.fn() }));
afterEach(cleanup);
const posting: PostingRowData = { id: 'job', title: 'Flight Intern', company: 'Example', company_slug: 'example',
  location: '', locations: [], url: 'https://example.com/job', source: 'test', first_seen_at: '', closed_at: null,
  category: null, category_tags: [], term: null, eligibility: null, score: null, score_breakdown: null, compensation: null };
it('shows incoming description immediately even when the database queue is busy', () => {
  render(<JobDetail posting={{ ...posting, description_text: 'Build aircraft engines.', description_status: 'available' }} onClose={() => {}} onAction={() => {}} />);
  expect(screen.getByText('Build aircraft engines.')).toBeTruthy();
  expect(screen.queryByLabelText('Loading description')).toBeNull();
});
it('shows the employer-page fallback immediately when incoming text is unavailable', () => {
  render(<JobDetail posting={{ ...posting, description_text: null, description_status: 'unavailable' }} onClose={() => {}} onAction={() => {}} />);
  expect(screen.getByText('The full story is on the company site.')).toBeTruthy();
  expect(screen.queryByLabelText('Loading description')).toBeNull();
});
it('labels unknown pay honestly and lists every formatted location', () => {
  render(<JobDetail posting={{ ...posting, locations: ['San Francisco, CA', 'New York, NY'],
    description_text: null, description_status: 'unavailable' }} onAction={() => {}} />);
  expect(screen.getByText('Check posting')).toBeTruthy();
  expect(screen.getByText(/Pay isn’t confirmed here/)).toBeTruthy();
  expect(screen.getByText('San Francisco, CA; New York, NY')).toBeTruthy();
});
it('shows a verified amount without an unknown-pay prompt', () => {
  render(<JobDetail posting={{ ...posting, pay_label: '$52/hr', description_text: null,
    description_status: 'unavailable' }} onAction={() => {}} />);
  expect(screen.getByText('$52/hr')).toBeTruthy();
  expect(screen.queryByText('Check posting')).toBeNull();
});
