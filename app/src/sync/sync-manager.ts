import type { Database } from '@/db/database';
import type { Profile } from '@/profile/types';
import { DEFAULT_SYNC_INTERVAL_MS } from '@/profile/types';
import { syncFeed, getLastSyncedAt, type SyncResult } from './feed-sync';
import { notifyWatchedJobs } from './watch-alerts';
import { recomputeGuestCategories } from '@/classify/guest-classification';
import { recomputePendingCategoryTaxonomy } from '@/classify/recompute';
import { refreshJobDetails } from '@/details/cache';
import { runAutoGhost } from '@/views/Pipeline/auto-ghost';
import { isTauri, updateTrayInfo, GMAIL_ENABLED } from '@/lib/platform';
import { isGmailConnected } from '@/integrations/gmail-auth';
import { runGmailScan } from '@/integrations/gmail-service';
import { maintenanceActive, trackWorkspaceTask } from '@/lib/maintenance';

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt: string | null;
  newPostingCount: number;
  lastError: string | null;
}

export type SyncListener = (state: SyncState) => void;

// Refocusing the window triggers a sync; without a floor, tabbing back and forth
// re-runs the whole pipeline every time. Skip a focus-triggered sync if one ran
// within this window (interval, online and manual syncs are unaffected).
const FOREGROUND_SYNC_MIN_MS = 60_000;

export class SyncManager {
  private db: Database;
  private profile: Profile | null = null;
  private syncing = false;
  private started = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private listener: SyncListener | null = null;
  private state: SyncState = {
    status: 'idle',
    lastSyncedAt: getLastSyncedAt(),
    newPostingCount: 0,
    lastError: null,
  };
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private syncIntervalMs: number = DEFAULT_SYNC_INTERVAL_MS;
  private lastSyncStartedAt = 0;

  constructor(db: Database) {
    this.db = db;
  }

  setProfile(profile: Profile | null): void {
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
    if (this.started) return;
    this.started = true;
    void this.doSync();

    this.visibilityHandler = (): void => {
      if (document.visibilityState !== 'visible') return;
      // Don't re-run the pipeline on every refocus if one just ran.
      if (Date.now() - this.lastSyncStartedAt < FOREGROUND_SYNC_MIN_MS) return;
      void this.doSync();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);

    this.onlineHandler = (): void => {
      void this.doSync();
    };
    window.addEventListener('online', this.onlineHandler);

    this.intervalId = setInterval(() => {
      void this.doSync();
    }, this.syncIntervalMs);
  }

  stop(): void {
    this.started = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  async doSync(): Promise<SyncResult | null> {
    if (maintenanceActive()) return null;
    return trackWorkspaceTask(this.syncNow());
  }

  private async syncNow(): Promise<SyncResult | null> {
    if (this.syncing) return null;
    this.syncing = true;
    this.lastSyncStartedAt = Date.now();

    try {
      // Notify feed views before a local migration too, including offline launches.
      this.updateState({ status: 'syncing', lastError: null });
      await refreshJobDetails(this.db, this.profile);
      // Category migration is local and must not depend on network availability.
      if (this.profile) {
        await recomputePendingCategoryTaxonomy(this.db, this.profile);
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const cached = await this.db.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM postings_cache');
        if ((cached?.count ?? 0) > 0) {
          this.updateState({ status: 'idle', lastError: 'Offline' });
          return null;
        }
        // An empty cache still needs the local/bundled feed on first launch.
      }

      const ghosted = await runAutoGhost(this.db);
      if (ghosted > 0) {
        console.log(`[nightjar] auto-ghosted ${String(ghosted)} stale application(s)`);
      }

      const result = await syncFeed(this.db);
      if (!result.error && !result.skipped) {
        this.updateState({ lastSyncedAt: new Date().toISOString() });
      }
      // The pre-sync refreshJobDetails above already processed pending rows;
      // only re-run it when the sync actually brought new/changed postings.
      if (!result.error && !result.skipped) await refreshJobDetails(this.db, this.profile);

      if (result.error) {
        this.updateState({ status: 'error', lastError: result.error });
        return result;
      }

      if (!result.skipped && this.profile) {
        await recomputePendingCategoryTaxonomy(this.db, this.profile);
      }
      if (!this.profile) await recomputeGuestCategories(this.db);

      if (!result.skipped && result.newPostingIds.length > 0) {
        await notifyWatchedJobs(this.db, result.newPostingIds);
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

      // Shared public descriptions are the default. Retain the direct ATS helper for
      // explicit diagnostics, rather than multiplying employer requests per installation.

      if (GMAIL_ENABLED && isTauri()) {
        try {
          const connected = await isGmailConnected();
          if (connected) {
            const gmailNew = await runGmailScan(this.db);
            if (gmailNew > 0) {
              console.log(`[nightjar] Gmail scan found ${String(gmailNew)} new suggestion(s)`);
            }
          }
        } catch (gmailErr: unknown) {
          console.warn('[nightjar] Gmail scan failed:', gmailErr);
        }
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
