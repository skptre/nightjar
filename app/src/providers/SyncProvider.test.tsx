import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@/profile/types';

const testState = vi.hoisted(() => ({
  db: { run: vi.fn(() => Promise.resolve()) },
  profile: null as Profile | null,
  managers: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    setProfile: ReturnType<typeof vi.fn>;
    setSyncInterval: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@/providers/DatabaseProvider', () => ({
  useDatabase: () => ({ db: testState.db }),
}));

vi.mock('@/providers/ProfileProvider', () => ({
  useProfile: () => ({ profile: testState.profile }),
}));

vi.mock('@/sync/sync-manager', () => ({
  SyncManager: class {
    start = vi.fn();
    stop = vi.fn();
    setProfile = vi.fn();
    setSyncInterval = vi.fn();
    onStateChange = vi.fn();
    clearNewPostingCount = vi.fn();
    doSync = vi.fn();

    constructor() {
      testState.managers.push(this);
    }
  },
}));

vi.mock('@/lib/platform', () => ({
  listenForTraySync: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock('@/classify/recompute', () => ({
  recomputeAll: vi.fn(() => Promise.resolve(0)),
}));

import { SyncProvider } from './SyncProvider';

describe('SyncProvider lifecycle', () => {
  beforeEach(() => {
    testState.profile = null;
    testState.managers.length = 0;
    testState.db.run.mockClear();
  });

  it('keeps the same sync manager when profile preferences change', () => {
    const view = render(<SyncProvider><div>content</div></SyncProvider>);
    expect(testState.managers).toHaveLength(1);

    testState.profile = { sync_interval_ms: 60_000 } as Profile;
    view.rerender(<SyncProvider><div>content</div></SyncProvider>);

    expect(testState.managers).toHaveLength(1);
    expect(testState.managers[0]!.setProfile).toHaveBeenLastCalledWith(testState.profile);
    expect(testState.managers[0]!.setSyncInterval).toHaveBeenLastCalledWith(60_000);
  });
});
