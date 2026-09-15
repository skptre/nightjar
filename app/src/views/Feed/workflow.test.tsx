import type { Profile } from '@/profile/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NightjarDB } from '@/db/database';
import { FeedView } from './FeedView';
import { PipelineView } from '@/views/Pipeline/PipelineView';
import { upsertPostings } from '@/sync/feed-sync';
const state = vi.hoisted(() => ({ db: null as unknown, profile: null as Profile | null, lastSyncedAt: null as string | null, open: vi.fn(async () => true), toast: vi.fn(), clear: vi.fn() }));
vi.mock('@/providers/DatabaseProvider', () => ({ useDatabase: () => ({ db: state.db }) }));
vi.mock('@/providers/ProfileProvider', () => ({ useProfile: () => ({ profile: state.profile }) }));
vi.mock('@/providers/SyncProvider', () => ({ useSync: () => ({ status: 'idle', lastSyncedAt: state.lastSyncedAt, clearNewPostingCount: state.clear }) }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/lib/platform', () => ({ openExternal: state.open, isTauri: () => false }));
let db: NightjarDB;
beforeEach(async () => {
  localStorage.clear(); window.history.replaceState(null, '', '/'); state.open.mockClear();
  state.lastSyncedAt = null; state.profile = null;
  db = await NightjarDB.createInMemory(); state.db = db;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = vi.fn();
  await db.run('INSERT INTO postings_cache (id,data,description,first_seen_at,synced_at) VALUES (?,?,?,?,?)', ['job',
    JSON.stringify({ id: 'job', company: 'Test Aerospace', company_slug: 'test', title: 'Avionics Software Intern',
      source: 'test', url: 'https://example.com/job', description_status: 'available', locations: ['Boston, MA'] }),
    'Responsibilities\nBuild flight simulation tools.\n\nRequirements\nExperience with Python.\n\nOther information\nFinal source clause retained.', '2026-09-01', '2026-09-01']);
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await db.close(); });
it('opens a readable description, applies externally without claiming submission, and explicitly records an application', async () => {
  render(<FeedView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Avionics Software Intern' }));
  expect(await screen.findByText('Build flight simulation tools.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Read full description' }));
  expect(screen.getByText(/Final source clause retained/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(state.open).toHaveBeenCalledWith('https://example.com/job');
  expect(await db.queryOne('SELECT * FROM applications')).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: 'Mark applied' }));
  await waitFor(async () => expect((await db.queryOne<{ status: string }>('SELECT status FROM applications'))?.status).toBe('applied'));
});
it('edits tracker next steps and retains interview milestones after an application is archived', async () => {
  await db.run("INSERT INTO applications (posting_id,status,created_at,updated_at) VALUES ('job','saved','2026-09-01','2026-09-01')");
  render(<MemoryRouter><PipelineView /></MemoryRouter>);
  const next = await screen.findByLabelText('Next step for Test Aerospace');
  fireEvent.change(next, { target: { value: 'Prepare portfolio' } }); fireEvent.blur(next);
  await waitFor(async () => expect((await db.queryOne<{ next_action: string }>('SELECT next_action FROM applications'))?.next_action).toBe('Prepare portfolio'));
  fireEvent.change(screen.getByLabelText('Stage for Test Aerospace'), { target: { value: 'phone' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Skip details' }));
  await waitFor(() => expect(screen.getByLabelText('Stage for Test Aerospace')).toHaveProperty('value','phone'));
  fireEvent.change(screen.getByLabelText('Stage for Test Aerospace'), { target: { value: 'rejected' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Skip details' }));
  await waitFor(() => expect(screen.getByLabelText('Stage for Test Aerospace')).toHaveProperty('value','rejected'));
  expect(screen.getByLabelText('Application milestones').textContent).toContain('1Interviews');
  expect((await db.queryOne<{ next_action: string }>('SELECT next_action FROM applications'))?.next_action).toBe('Prepare portfolio');
});
it('does not let a public feed close manually added tracker records', async () => {
  await db.run('INSERT INTO postings_cache (id,data,synced_at) VALUES (?,?,?)', ['local-example', JSON.stringify({ source: 'manual' }), '2026-09-01']);
  await upsertPostings(db, { version: 1, updated_at: '2026-09-08', count: 0, postings: {} });
  expect((await db.queryOne<{ closed_at: string | null }>("SELECT closed_at FROM postings_cache WHERE id='local-example'"))?.closed_at).toBeNull();
});
it('refreshes an open description while keeping newly arrived rows behind Show', async () => {
  const view = render(<FeedView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Avionics Software Intern' }));
  await screen.findByText('Build flight simulation tools.');
  await db.run('UPDATE postings_cache SET description=? WHERE id=?', ['Responsibilities\nUpdated flight testing duties.', 'job']);
  await db.run('INSERT INTO postings_cache (id,data,first_seen_at,synced_at) VALUES (?,?,?,?)', ['new-job',
    JSON.stringify({ title: 'Propulsion Intern', company: 'Test Aerospace', source: 'test', locations: [] }), '2026-09-08', '2026-09-08']);
  state.lastSyncedAt = '2026-09-08'; view.rerender(<FeedView />);
  expect(await screen.findByText('Updated flight testing duties.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Propulsion Intern' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /1 new role available/ }));
  expect(await screen.findByRole('button', { name: 'Propulsion Intern' })).toBeTruthy();
});

it('filters graduate jobs by graduation in For you while All jobs remains browsable', async () => {
  const nextYear = new Date().getFullYear() + 1;
  state.profile = { graduation: `${nextYear + 2}-05`, target_categories: [] } as unknown as Profile;
  await db.run('INSERT INTO postings_cache (id,data,term,first_seen_at,synced_at) VALUES (?,?,?,?,?)', ['graduate',
    JSON.stringify({ title: 'Software Engineer New Grad', company: 'Test Aerospace', locations: [] }), 'new_grad', '2026-09-01', '2026-09-01']);
  const view = render(<FeedView />);
  await screen.findByRole('button', { name: 'Avionics Software Intern' });
  // The feed starts fresh on All jobs, so every role is visible.
  expect(await screen.findByRole('button', { name: 'Software Engineer New Grad' })).toBeTruthy();
  // For you hides a new-grad role when graduation is far off.
  fireEvent.click(screen.getByRole('button', { name: 'For you' }));
  expect(screen.queryByRole('button', { name: 'Software Engineer New Grad' })).toBeNull();
  // Editing graduation to this cycle brings it back within For you.
  state.profile = { ...state.profile, graduation: `${nextYear}-05` };
  view.rerender(<FeedView />);
  expect(await screen.findByRole('button', { name: 'Software Engineer New Grad' })).toBeTruthy();
});
