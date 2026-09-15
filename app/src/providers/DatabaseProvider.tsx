import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createDatabase, type Database } from '@/db/database';
import { finishPendingRestore } from '@/backup/workspace';

interface DatabaseContextValue {
  db: Database;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function useDatabase(): DatabaseContextValue {
  const ctx = useContext(DatabaseContext);
  if (!ctx) throw new Error('useDatabase must be used within DatabaseProvider');
  return ctx;
}

export function DatabaseProvider({ children }: { children: ReactNode }): ReactNode {
  const [db, setDb] = useState<Database | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    createDatabase()
      .then(async instance => { await finishPendingRestore(instance); return instance; })
      .then((instance) => {
        if (!cancelled) setDb(instance);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-nj-bg">
        <div className="text-center p-8 max-w-md">
          <h1 className="text-xl font-bold text-red-600 dark:text-red-400">Database Error</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-nj-muted">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-nj-accent text-white rounded-md hover:bg-nj-accent-dim"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (!db) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-nj-bg">
        <div className="flex flex-col items-center gap-3">
          <svg className="w-8 h-8 animate-spin text-violet-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm text-gray-500 dark:text-nj-muted">Loading Nightjar…</p>
        </div>
      </div>
    );
  }

  return <DatabaseContext.Provider value={{ db }}>{children}</DatabaseContext.Provider>;
}
