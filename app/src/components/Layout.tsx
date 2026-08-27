import { useState, useEffect, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSync } from '@/providers/SyncProvider';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps): ReactNode {
  const { status, lastSyncedAt, newPostingCount } = useSync();
  const { online } = useNetworkStatus();
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem('nightjar_dark_mode');
    return stored === null ? true : stored === 'true';
  });

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
    <div className="min-h-screen bg-gray-50 dark:bg-nj-bg text-gray-900 dark:text-nj-text">
      <nav className="border-b border-gray-200 dark:border-nj-border bg-white dark:bg-nj-surface sticky top-0 z-40" role="navigation" aria-label="Main navigation">
        <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-14">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-lg tracking-tight bg-gradient-to-r from-nj-accent-bright to-nj-cat-swe bg-clip-text text-transparent">
              nightjar
            </span>
            <div className="flex gap-1">
              <NavTab to="/" end>
                Feed
                {newPostingCount > 0 && (
                  <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-nj-accent text-white">
                    {newPostingCount}
                  </span>
                )}
              </NavTab>
              <NavTab to="/pipeline">Pipeline</NavTab>
              <NavTab to="/calendar">Calendar</NavTab>
              <NavTab to="/companies">Companies</NavTab>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <SyncIndicator status={status} lastSyncedAt={lastSyncedAt} />
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `p-2 rounded-md transition-colors ${
                  isActive
                    ? 'text-nj-accent-bright'
                    : 'text-gray-500 hover:text-gray-700 dark:text-nj-muted dark:hover:text-nj-text'
                }`
              }
              aria-label="Settings"
            >
              <GearIcon />
            </NavLink>
            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-md text-gray-500 hover:text-gray-700 dark:text-nj-muted dark:hover:text-nj-text transition-colors"
              aria-label="Toggle dark mode"
            >
              {darkMode ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>
      </nav>
      {!online && (
        <div
          className="bg-amber-500 text-white text-center text-sm py-1.5 font-medium"
          role="alert"
          data-testid="offline-banner"
        >
          No internet connection. Showing cached data.
        </div>
      )}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {children}
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
  children: ReactNode;
}): ReactNode {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          isActive
            ? 'bg-violet-50 text-violet-700 dark:bg-nj-accent/15 dark:text-nj-accent-bright'
            : 'text-gray-600 hover:text-gray-900 dark:text-nj-text-dim dark:hover:text-nj-text'
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
}): ReactNode {
  if (status === 'syncing') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-nj-muted">
        <svg className="w-4 h-4 animate-spin text-nj-accent-bright" viewBox="0 0 24 24" fill="none">
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
    return <span className="text-sm text-nj-ineligible">Sync error</span>;
  }
  if (lastSyncedAt) {
    return (
      <span className="text-sm text-gray-500 dark:text-nj-muted">
        Synced {formatRelativeTime(lastSyncedAt)}
      </span>
    );
  }
  return <span className="text-sm text-gray-500 dark:text-nj-muted">Not synced</span>;
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

function SunIcon(): ReactNode {
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

function MoonIcon(): ReactNode {
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

function GearIcon(): ReactNode {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  );
}
