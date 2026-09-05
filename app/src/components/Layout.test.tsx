import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    testState.online = true;
    testState.status = 'idle';
    testState.lastSyncedAt = null;
  });

  it('keeps the last-update time instead of showing a sync failure over usable data', () => {
    testState.status = 'error';
    testState.lastSyncedAt = new Date().toISOString();

    renderLayout();

    expect(screen.getByText('Updated just now')).toBeTruthy();
    expect(screen.queryByText(/sync error/i)).toBeNull();
    expect(screen.queryByText(/cached/i)).toBeNull();
  });

  it('uses a concise offline message without cache terminology', () => {
    testState.online = false;

    renderLayout();

    expect(screen.getByRole('alert').textContent).toBe("You're offline.");
    expect(screen.queryByText(/cached/i)).toBeNull();
  });
});
