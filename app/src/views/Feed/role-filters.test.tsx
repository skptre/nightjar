import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NightjarDB } from '@/db/database';
import { recomputePendingCategoryTaxonomy } from '@/classify/recompute';
import type { Profile } from '@/profile/types';
import { FeedView } from './FeedView';

const state = vi.hoisted(() => ({ db: null as unknown, clear: vi.fn(), toast: vi.fn() }));
vi.mock('@/providers/DatabaseProvider', () => ({ useDatabase: () => ({ db: state.db }) }));
vi.mock('@/providers/ProfileProvider', () => ({ useProfile: () => ({ profile: null }) }));
vi.mock('@/providers/SyncProvider', () => ({ useSync: () => ({ status: 'idle', clearNewPostingCount: state.clear }) }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: state.toast }) }));

const profile: Profile = {
  graduation: '2029-05', grad_window: ['2028-11', '2029-06'], current_class_year: 'junior',
  work_auth: 'us_citizen', requires_sponsorship: false, target_categories: ['swe'],
  locations: ['US'], excluded_companies: [], tiers: {}, contacts: {},
};

describe('role filters with migrated cached postings', () => {
  let db: NightjarDB;
  beforeEach(async () => {
    db = await NightjarDB.createInMemory();
    state.db = db;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    HTMLElement.prototype.scrollTo = vi.fn();
    const titles = ['Avionics Software Engineer Intern', 'Propulsion Engineer Intern',
      'Software Engineer Intern', 'Quantitative Developer Intern', 'Quantitative Research Intern',
      'FPGA Engineer - High Frequency Trading Intern'];
    for (const [index, title] of titles.entries()) {
      const posting = { id: String(index), title, company: 'Example', company_slug: 'example',
        locations: ['New York, NY'], url: 'https://example.com/jobs', source: 'test',
        first_seen_at: '2026-09-01T00:00:00Z', posted_at: null, closed_at: null };
      await db.run(`INSERT INTO postings_cache (id, data, category, category_tags, score, first_seen_at, synced_at)
        VALUES (?, ?, 'aero', '["aero","swe"]', 75, ?, ?)`,
      [posting.id, JSON.stringify(posting), posting.first_seen_at, posting.first_seen_at]);
    }
  });
  afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await db.close(); });

  it('reclassifies populated legacy rows once and applies both axes in the rendered feed', async () => {
    expect(await recomputePendingCategoryTaxonomy(db, profile)).toBe(6);
    expect(await recomputePendingCategoryTaxonomy(db, profile)).toBe(0);
    render(<FeedView />);
    await screen.findByRole('button', { name: 'Avionics Software Engineer Intern' });
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aero' }));
    expect(screen.queryByRole('button', { name: 'Avionics Software Engineer Intern' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Propulsion Engineer Intern' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aero' }));
    fireEvent.click(screen.getByRole('button', { name: 'SWE' }));
    fireEvent.click(screen.getByRole('button', { name: 'Aerospace' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Avionics Software Engineer Intern' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aerospace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Quant finance' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Quantitative Developer Intern' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'SWE' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Hardware' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'FPGA Engineer - High Frequency Trading Intern' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(6));
  });
});

