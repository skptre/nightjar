import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/db/database';
import { SyncManager } from './sync-manager';
import * as feed from './feed-sync';
import * as details from '@/details/cache';

describe('SyncManager lifecycle', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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

  it('automatically checks again after the default five-minute interval', async () => {
    vi.useFakeTimers();
    const manager = new SyncManager({} as Database);
    const sync = vi.spyOn(manager, 'doSync').mockResolvedValue(null);
    manager.start();
    expect(sync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sync).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it('imports jobs before refreshing cached details', async () => {
    const order: string[] = [];
    vi.spyOn(feed, 'syncFeed').mockImplementation(async () => {
      order.push('feed');
      return { newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: false, error: 'Offline' };
    });
    vi.spyOn(details, 'refreshJobDetails').mockImplementation(async () => { order.push('details'); return 0; });
    const db = { query: vi.fn().mockResolvedValue([]), queryOne: vi.fn().mockResolvedValue(undefined),
      batch: vi.fn().mockResolvedValue(undefined), run: vi.fn().mockResolvedValue(undefined) } as unknown as Database;
    await new SyncManager(db).doSync();
    expect(order).toEqual(['feed', 'details']);
  });

  it('does not invalidate the visible feed when an unchanged sync only updates its timestamp', async () => {
    const result = {newPostingIds: [], updatedCount: 0, closedCount: 0, totalCount: 0, skipped: false};
    vi.spyOn(feed, 'syncFeed').mockResolvedValueOnce(result).mockResolvedValueOnce({...result, skipped: true});
    vi.spyOn(details, 'refreshJobDetails').mockResolvedValue(0);
    const db = {query: vi.fn().mockResolvedValue([]), queryOne: vi.fn().mockResolvedValue(undefined),
      batch: vi.fn().mockResolvedValue(undefined), run: vi.fn().mockResolvedValue(undefined)} as unknown as Database;
    const manager = new SyncManager(db);
    await manager.doSync();
    const revision = manager.getState().dataRevision;
    expect(revision).toBe(1);
    await manager.doSync();
    expect(manager.getState().dataRevision).toBe(revision);
    expect(manager.getState().status).toBe('idle');
  });
});


it.each([0, 1])('attempts sync while offline with %i cached postings', async count => {
  const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const sync = vi.spyOn(feed, 'syncFeed').mockResolvedValue({ newPostingIds: [], updatedCount: 0,
    closedCount: 0, totalCount: 0, skipped: false, error: 'Offline' });
  const db = { queryOne: vi.fn().mockResolvedValue({ count }), query: vi.fn().mockResolvedValue([]), batch: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined) } as unknown as Database;
  try {
    const manager = new SyncManager(db);
    await manager.doSync();
    expect(sync).toHaveBeenCalledOnce();
    expect(manager.getState()).toMatchObject({ status: 'idle', lastError: 'Offline' });
  } finally { sync.mockRestore(); offline.mockRestore(); }
});
