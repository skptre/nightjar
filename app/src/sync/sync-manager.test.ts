import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/db/database';
import { SyncManager } from './sync-manager';

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
