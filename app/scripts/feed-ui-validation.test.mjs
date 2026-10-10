import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { NightjarDB } from '@/db/database';
import { syncFeed } from '@/sync/feed-sync';
import { FeedView } from '@/views/Feed/FeedView';
import { setFeed } from '@/views/Feed/feed-store';
import { formatDescription, pruneHeadings } from '@/details/format';
const state = vi.hoisted(() => ({ db: null, clear: () => {}, toast: () => {} }));
vi.mock('@/providers/DatabaseProvider', () => ({ useDatabase: () => ({ db: state.db }) }));
vi.mock('@/providers/ProfileProvider', () => ({ useProfile: () => ({ profile: null }) }));
vi.mock('@/providers/SyncProvider', () => ({ useSync: () => ({ status: 'idle', lastSyncedAt: null, clearNewPostingCount: state.clear }) }));
vi.mock('@/components/Toast', () => ({ useToast: () => ({ toast: state.toast }) }));
it.skipIf(!process.env.NIGHTJAR_RELEASE_DIR)('renders all active jobs and opens full recovered text from the real feed', async () => {
  const root = resolve(process.env.NIGHTJAR_RELEASE_DIR);
  const expected = JSON.parse(readFileSync(resolve(root, 'feed.json'), 'utf8'));
  const active = Object.values(expected.postings).filter(p => !p.closed_at);
  const target = active.find(p => p.description_text && p.description_status === 'available');
  localStorage.clear();
  window.history.replaceState(null, '', '/jobs');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async input => {
    const path = new URL(String(input), 'https://local.example').pathname.replace(/^\/candidate\//, '');
    if (!/^(?:meta\.json|feed\.json|feed\/(?:[a-z_-]+\.json|details\/descriptions-[a-f0-9]\.json))$/.test(path)) return new Response('', { status: 404 });
    return new Response(readFileSync(resolve(root, path), 'utf8'));
  }));
  const db = await NightjarDB.createInMemory(); state.db = db;
  try {
    expect((await syncFeed(db, '/candidate')).error).toBeUndefined();
    render(React.createElement(FeedView));
    await screen.findByText(new RegExp(`${active.length.toLocaleString()} roles`), {}, { timeout: 30000 });
    await act(async () => { setFeed({ search: target.title }); });
    const buttons = await screen.findAllByRole('button', { name: target.title });
    fireEvent.click(buttons[0]);
    const full = screen.queryByRole('button', { name: 'Read full description' });
    if (full) fireEvent.click(full);
    const expectedBlocks = pruneHeadings(formatDescription(target.description_text));
    const expectedText = expectedBlocks.flatMap(block => block.kind === 'list' ? block.items : [block.text]).join('');
    await waitFor(() => {
      const rendered = [...document.querySelectorAll('.post-desc .desc-h, .post-desc .desc-p, .post-desc .desc-ul li')]
        .map(element => element.textContent).join('');
      expect(rendered).toBe(expectedText);
    });
  } finally { cleanup(); vi.unstubAllGlobals(); await db.close(); }
}, 60000);
