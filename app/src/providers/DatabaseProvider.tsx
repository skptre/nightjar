import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NightjarDB } from '@/db/database';

interface DatabaseContextValue {
  db: NightjarDB;
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null);

export function useDatabase(): DatabaseContextValue {
  const ctx = useContext(DatabaseContext);
  if (!ctx) throw new Error('useDatabase must be used within DatabaseProvider');
  return ctx;
}

export function DatabaseProvider({ children }: { children: ReactNode }): ReactNode {
  const [db, setDb] = useState<NightjarDB | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    NightjarDB.create()
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
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="text-center p-8 max-w-md">
          <h1 className="text-xl font-bold text-red-600 dark:text-red-400">Database Error</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (!db) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
        <p className="text-gray-500 dark:text-gray-400">Loading database…</p>
      </div>
    );
  }

  return <DatabaseContext.Provider value={{ db }}>{children}</DatabaseContext.Provider>;
}
