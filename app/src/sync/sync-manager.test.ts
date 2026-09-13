import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/db/database';
import { SyncManager } from './sync-manager';
import * as feed from './feed-sync';

describe('SyncManager lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not register duplicate triggers when started twice', () => {
    const manager = new SyncManager({} as Database);
    const sync = vi.spyOn(manager, 'doSync').mockResolvedValue(null);
    const documentListener = vi.spyOn(document, 'addEventListener');
    const windowListener = vi.spyOn(window, 'addEventListener');

    manager.start();
    manager.start();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(documentListener.mock.calls.filter(([event]) => event === 'visibilitychange')).toHaveLength(1);
    expect(windowListener.mock.calls.filter(([event]) => event === 'online')).toHaveLength(1);

    manager.stop();
  });
});


it('attempts sync while offline so packaged startup can use its bundled snapshot', async () => {
  const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const sync = vi.spyOn(feed, 'syncFeed').mockResolvedValue({ newPostingIds: [], updatedCount: 0,
    closedCount: 0, totalCount: 0, skipped: false, error: 'Offline' });
  const db = { queryOne: vi.fn().mockResolvedValue({ count: 0 }), query: vi.fn().mockResolvedValue([]), batch: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined) } as unknown as Database;
  try {
    await new SyncManager(db).doSync();
    expect(sync).toHaveBeenCalledOnce();
  } finally { sync.mockRestore(); offline.mockRestore(); }
});
