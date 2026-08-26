import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import { DEFAULT_SYNC_INTERVAL_MS } from '@/profile/types';
import { syncFeed, getLastSyncedAt, type SyncResult } from './feed-sync';
import { fireNewPostingNotifications, requestNotificationPermission } from './notifications';
import { prefetchDescriptions } from './description-fetch';
import { recomputeNewPostings } from '@/classify/recompute';
import { runAutoGhost } from '@/views/Pipeline/auto-ghost';
import { updateTrayInfo } from '@/lib/platform';

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt: string | null;
  newPostingCount: number;
  lastError: string | null;
}

export type SyncListener = (state: SyncState) => void;

export class SyncManager {
  private db: Database;
  private profile: Profile | null = null;
  private syncing = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private listener: SyncListener | null = null;
  private state: SyncState = {
    status: 'idle',
    lastSyncedAt: getLastSyncedAt(),
    newPostingCount: 0,
    lastError: null,
  };
  private visibilityHandler: (() => void) | null = null;
  private permissionRequested = false;
  private syncIntervalMs: number = DEFAULT_SYNC_INTERVAL_MS;

  constructor(db: Database) {
    this.db = db;
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
  }

  onStateChange(listener: SyncListener): void {
    this.listener = listener;
  }

  getState(): SyncState {
    return { ...this.state };
  }

  setSyncInterval(ms: number): void {
    this.syncIntervalMs = ms;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = setInterval(() => {
        void this.doSync();
      }, this.syncIntervalMs);
    }
  }

  start(): void {
    void this.doSync();

    this.visibilityHandler = (): void => {
      if (document.visibilityState === 'visible') {
        void this.doSync();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);

    this.intervalId = setInterval(() => {
      void this.doSync();
    }, this.syncIntervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  async doSync(): Promise<SyncResult | null> {
    if (this.syncing) return null;
    this.syncing = true;
    this.updateState({ status: 'syncing', lastError: null });

    try {
      const ghosted = await runAutoGhost(this.db);
      if (ghosted > 0) {
        console.log(`[nightjar] auto-ghosted ${String(ghosted)} stale application(s)`);
      }

      const result = await syncFeed(this.db);

      if (!result.skipped && this.profile) {
        const idsToClassify = result.newPostingIds.length > 0
          ? result.newPostingIds
          : [];
        const unscoredRows = await this.db.query<{ id: string }>(
          'SELECT id FROM postings_cache WHERE (category IS NULL OR score IS NULL) AND closed_at IS NULL',
        );
        const unscored = unscoredRows.map((r) => r.id);
        const allIds = [...new Set([...idsToClassify, ...unscored])];
        if (allIds.length > 0) {
          await recomputeNewPostings(this.db, allIds, this.profile);
        }
      }

      if (!result.skipped && result.newPostingIds.length > 0) {
        if (!this.permissionRequested) {
          await requestNotificationPermission();
          this.permissionRequested = true;
        }
        await fireNewPostingNotifications(this.db, result.newPostingIds);
      }

      const updatedCount = result.skipped
        ? this.state.newPostingCount
        : this.state.newPostingCount + result.newPostingIds.length;

      this.updateState({
        status: 'idle',
        lastSyncedAt: new Date().toISOString(),
        newPostingCount: updatedCount,
      });

      void updateTrayInfo('just now', updatedCount);

      if (!result.skipped) {
        void prefetchDescriptions(this.db, undefined, this.profile ?? undefined);
      }

      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateState({ status: 'error', lastError: message });
      return null;
    } finally {
      this.syncing = false;
    }
  }

  clearNewPostingCount(): void {
    this.updateState({ newPostingCount: 0 });
  }

  private updateState(partial: Partial<SyncState>): void {
    this.state = { ...this.state, ...partial };
    this.listener?.(this.getState());
  }
}
