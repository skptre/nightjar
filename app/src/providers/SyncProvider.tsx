import { createContext, useContext, useEffect, useState, useRef, useCallback, type ReactNode } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { SyncManager, type SyncStatus } from '@/sync/sync-manager';

interface SyncContextValue {
  status: SyncStatus;
  lastSyncedAt: string | null;
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
  const managerRef = useRef<SyncManager | null>(null);
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [newPostingCount, setNewPostingCount] = useState(0);

  useEffect(() => {
    const manager = new SyncManager(db);
    managerRef.current = manager;

    if (profile) {
      manager.setProfile(profile);
    }

    manager.onStateChange((state) => {
      setStatus(state.status);
      setLastSyncedAt(state.lastSyncedAt);
      setNewPostingCount(state.newPostingCount);
    });

    manager.start();

    return () => {
      manager.stop();
      managerRef.current = null;
    };
  }, [db, profile]);

  const clearNewPostingCount = useCallback(() => {
    managerRef.current?.clearNewPostingCount();
  }, []);

  return (
    <SyncContext.Provider value={{ status, lastSyncedAt, newPostingCount, clearNewPostingCount }}>
      {children}
    </SyncContext.Provider>
  );
}
