import { createContext, useContext, type ReactNode } from 'react';

export type SyncStatus = 'idle' | 'syncing' | 'error';

interface SyncContextValue {
  status: SyncStatus;
  lastSyncedAt: string | null;
  newPostingCount: number;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within SyncProvider');
  return ctx;
}

export function SyncProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <SyncContext.Provider value={{ status: 'idle', lastSyncedAt: null, newPostingCount: 0 }}>
      {children}
    </SyncContext.Provider>
  );
}
