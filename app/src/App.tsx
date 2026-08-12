import { useState, useEffect } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { useSync } from '@/providers/SyncProvider';
import { FeedView } from '@/views/Feed/FeedView';
import { PipelineView } from '@/views/Pipeline/PipelineView';
import { CompaniesView } from '@/views/Companies/CompaniesView';

export function App(): React.ReactNode {
  const { status, lastSyncedAt, newPostingCount } = useSync();
  const [darkMode, setDarkMode] = useState(() =>
    localStorage.getItem('nightjar_dark_mode') === 'true',
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const toggleDarkMode = (): void => {
    setDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem('nightjar_dark_mode', String(next));
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <nav className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-14">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-lg tracking-tight">nightjar</span>
            <div className="flex gap-1">
              <NavTab to="/" end>
                Feed
                {newPostingCount > 0 && (
                  <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-600 text-white">
                    {newPostingCount}
                  </span>
                )}
              </NavTab>
              <NavTab to="/pipeline">Pipeline</NavTab>
              <NavTab to="/companies">Companies</NavTab>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <SyncIndicator status={status} lastSyncedAt={lastSyncedAt} />
            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-md text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
              aria-label="Toggle dark mode"
            >
              {darkMode ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<FeedView />} />
          <Route path="/pipeline" element={<PipelineView />} />
          <Route path="/companies" element={<CompaniesView />} />
        </Routes>
      </main>
    </div>
  );
}

function NavTab({
  to,
  end = false,
  children,
}: {
  to: string;
  end?: boolean | undefined;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          isActive
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
            : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function SyncIndicator({
  status,
  lastSyncedAt,
}: {
  status: string;
  lastSyncedAt: string | null;
}): React.ReactNode {
  if (status === 'syncing') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        Syncing…
      </span>
    );
  }
  if (status === 'error') {
    return <span className="text-sm text-red-500">Sync error</span>;
  }
  if (lastSyncedAt) {
    return (
      <span className="text-sm text-gray-500 dark:text-gray-400">
        Synced {formatRelativeTime(lastSyncedAt)}
      </span>
    );
  }
  return <span className="text-sm text-gray-500 dark:text-gray-400">Not synced</span>;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

function SunIcon(): React.ReactNode {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
      />
    </svg>
  );
}

function MoonIcon(): React.ReactNode {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
      />
    </svg>
  );
}
