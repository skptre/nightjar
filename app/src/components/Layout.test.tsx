import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  online: true,
  status: 'idle',
  lastSyncedAt: null as string | null,
}));

vi.mock('@/providers/SyncProvider', () => ({
  useSync: () => ({
    status: testState.status,
    lastSyncedAt: testState.lastSyncedAt,
  }),
}));

vi.mock('@/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => ({ online: testState.online }),
}));

import { Layout } from './Layout';

function renderLayout(): void {
  render(
    <MemoryRouter>
      <Layout><div>page</div></Layout>
    </MemoryRouter>,
  );
}

describe('Layout sync status', () => {
  afterEach(cleanup);
  beforeEach(() => {
    testState.online = true;
    testState.status = 'idle';
    testState.lastSyncedAt = null;
  });

  it('explains a failed update without persistent technical status labels', () => {
    testState.status = 'error';
    testState.lastSyncedAt = new Date().toISOString();

    renderLayout();

    expect(screen.queryByText(/Updated just now/)).toBeNull();
    expect(screen.getByRole('status').textContent).toContain("Couldn't check for new jobs.");
    expect(screen.queryByText(/sync error/i)).toBeNull();
    expect(screen.queryByText(/cached/i)).toBeNull();
  });

  it('uses a concise offline message without cache terminology', () => {
    testState.online = false;

    renderLayout();

    expect(screen.getByRole('alert').textContent).toBe("You're offline. Your saved information is still available.");
    expect(screen.queryByText(/cached/i)).toBeNull();
  });
  it('keeps successful background work invisible and exposes three destinations', () => {
    testState.status = 'syncing';
    renderLayout();
    expect(screen.queryByText(/syncing|not synced|updated/i)).toBeNull();
    for (const name of ['Home', 'Jobs', 'Tracker']) expect(screen.getByRole('link', { name })).toBeTruthy();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
