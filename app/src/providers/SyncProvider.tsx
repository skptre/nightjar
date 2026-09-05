import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { SyncManager, type SyncStatus } from '@/sync/sync-manager';
import { DEFAULT_SYNC_INTERVAL_MS } from '@/profile/types';
import { listenForTraySync } from '@/lib/platform';
import { recomputeAll } from '@/classify/recompute';

interface SyncContextValue {
  status: SyncStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  newPostingCount: number;
  clearNewPostingCount: () => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export type { SyncStatus };

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
}

export function SyncProvider({ children }: { children: ReactNode }): ReactNode {
  const { db } = useDatabase();
  const { profile } = useProfile();
  const manager = useMemo(() => new SyncManager(db), [db]);
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [newPostingCount, setNewPostingCount] = useState(0);

  useEffect(() => {
    manager.setProfile(profile);
    manager.setSyncInterval(profile?.sync_interval_ms ?? DEFAULT_SYNC_INTERVAL_MS);

    // Defer one tick so React StrictMode can cancel its development-only first
    // effect pass instead of running two expensive full-feed recomputations.
    const classificationTimer = setTimeout(() => {
      const refresh = profile
        ? recomputeAll(db, profile)
        : db.run(
          'UPDATE postings_cache SET eligibility = NULL, score = NULL, score_breakdown = NULL',
        );
      void refresh.catch((error: unknown) => {
        console.warn('[nightjar] profile classification refresh failed:', error);
      });
    }, 0);

    return () => clearTimeout(classificationTimer);
  }, [db, manager, profile]);

  useEffect(() => {
    manager.onStateChange((state) => {
      setStatus(state.status);
      setLastSyncedAt(state.lastSyncedAt);
      setLastError(state.lastError);
      setNewPostingCount(state.newPostingCount);
    });

    manager.start();

    let unlistenTray: (() => void) | null = null;
    let disposed = false;
    void listenForTraySync(() => {
      void manager.doSync();
    }).then((fn) => {
      if (disposed) fn?.();
      else unlistenTray = fn;
    });

    return () => {
      disposed = true;
      manager.stop();
      unlistenTray?.();
    };
  }, [manager]);

  const clearNewPostingCount = useCallback(() => {
    manager.clearNewPostingCount();
  }, [manager]);

  return (
    <SyncContext.Provider value={{ status, lastSyncedAt, lastError, newPostingCount, clearNewPostingCount }}>
      {children}
    </SyncContext.Provider>
  );
}
