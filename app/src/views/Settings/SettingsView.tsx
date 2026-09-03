import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { useProfile } from '@/providers/ProfileProvider';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useToast } from '@/components/Toast';
import { isTauri } from '@/lib/platform';
import {
  WORK_AUTH_OPTIONS,
  CLASS_YEAR_OPTIONS,
  CATEGORY_GROUPS,
  SYNC_INTERVAL_OPTIONS,
  DEFAULT_SYNC_INTERVAL_MS,
  computeGradWindow,
  inferRequiresSponsorship,
} from '@/profile/types';
import { clearProfile } from '@/profile/profile-store';
import { exportApplicationsCSV } from '@/export/export-csv';
import { exportApplicationsJSON } from '@/export/export-json';
import { exportPostingsJSON } from '@/export/export-postings';
import { saveFile } from '@/export/file-save';
import { recomputeAll } from '@/classify/recompute';

export function SettingsView(): ReactNode {
  return (
    <div className="max-w-2xl mx-auto space-y-8 pb-12">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-nj-text">Settings</h1>
      <GeneralSection />
      <SyncSection />
      <ProfileSection />
      <NotificationsSection />
      <DataSection />
    </div>
  );
}

/* ── General ────────────────────────────────────────── */

function GeneralSection(): ReactNode {
  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem('nightjar_dark_mode');
    return stored === null ? true : stored === 'true';
  });

  const toggleDarkMode = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem('nightjar_dark_mode', String(next));
      document.documentElement.classList.toggle('dark', next);
      return next;
    });
  }, []);

  return (
    <Section title="General">
      <ToggleRow
        label="Dark mode"
        description="Use dark color scheme"
        checked={darkMode}
        disabled={false}
        onChange={toggleDarkMode}
      />
      {isTauri() && <AutoLaunchRow />}
      {isTauri() && (
        <div className="border-t border-gray-100 dark:border-nj-border pt-4">
          <p className="text-sm text-gray-500 dark:text-nj-muted">
            Closing the window minimizes Nightjar to the system tray. Use the tray icon or
            &ldquo;Quit&rdquo; from the tray menu to exit completely.
          </p>
        </div>
      )}
    </Section>
  );
}

function AutoLaunchRow(): ReactNode {
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { isEnabled } = await import('@tauri-apps/plugin-autostart');
        const enabled = await isEnabled();
        if (!cancelled) {
          setAutoLaunch(enabled);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback(async () => {
    setLoading(true);
    try {
      if (autoLaunch) {
        const { disable } = await import('@tauri-apps/plugin-autostart');
        await disable();
        setAutoLaunch(false);
      } else {
        const { enable } = await import('@tauri-apps/plugin-autostart');
        await enable();
        setAutoLaunch(true);
      }
    } catch (err: unknown) {
      console.error('Failed to toggle auto-launch:', err);
    } finally {
      setLoading(false);
    }
  }, [autoLaunch]);

  return (
    <ToggleRow
      label="Launch on startup"
      description="Start Nightjar minimized to tray when you log in"
      checked={autoLaunch}
      disabled={loading}
      onChange={() => void toggle()}
    />
  );
}

/* ── Sync ───────────────────────────────────────────── */

function SyncSection(): ReactNode {
  const { profile, updateProfile } = useProfile();
  const { toast } = useToast();
  const [showFeedUrl, setShowFeedUrl] = useState(false);
  const [feedUrl, setFeedUrl] = useState(() =>
    localStorage.getItem('nightjar_feed_url_override') ?? '',
  );

  const currentInterval = profile?.sync_interval_ms ?? DEFAULT_SYNC_INTERVAL_MS;

  const handleIntervalChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const ms = Number(e.target.value);
      updateProfile({ sync_interval_ms: ms });
      toast('Sync interval updated');
    },
    [updateProfile, toast],
  );

  const handleFeedUrlSave = useCallback(() => {
    const trimmed = feedUrl.trim();
    if (trimmed) {
      localStorage.setItem('nightjar_feed_url_override', trimmed);
    } else {
      localStorage.removeItem('nightjar_feed_url_override');
    }
    toast('Feed URL saved');
  }, [feedUrl, toast]);

  return (
    <Section title="Sync">
      <label className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-nj-text">Sync interval</p>
          <p className="text-xs text-gray-500 dark:text-nj-muted">
            How often Nightjar checks for new postings
          </p>
        </div>
        <select
          value={currentInterval}
          onChange={handleIntervalChange}
          className="rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nj-accent"
        >
          {SYNC_INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <div className="border-t border-gray-100 dark:border-nj-border pt-4">
        <button
          type="button"
          onClick={() => setShowFeedUrl((p) => !p)}
          className="text-xs text-gray-400 dark:text-nj-muted hover:text-gray-600 dark:hover:text-nj-text transition-colors"
        >
          {showFeedUrl ? 'Hide' : 'Show'} advanced
        </button>
        {showFeedUrl && (
          <div className="mt-3 space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim">
              Feed URL override
            </label>
            <div className="flex gap-2">
              <input
                type="url"
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
                placeholder="https://raw.githubusercontent.com/..."
                className="flex-1 rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nj-accent"
              />
              <button
                type="button"
                onClick={handleFeedUrlSave}
                className="rounded-md bg-nj-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-nj-accent-bright transition-colors"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-gray-400 dark:text-nj-muted">
              Point to a different feed source. Leave empty to use default. Requires app restart.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}

/* ── Profile ────────────────────────────────────────── */

function ProfileSection(): ReactNode {
  const { profile, updateProfile } = useProfile();
  const { db } = useDatabase();
  const [showWizardConfirm, setShowWizardConfirm] = useState(false);

  if (!profile) return null;

  const handleGraduationChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const graduation = e.target.value;
    updateProfile({
      graduation,
      grad_window: computeGradWindow(graduation),
    });
  };

  const handleWorkAuthChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const work_auth = e.target.value;
    const sponsorship = inferRequiresSponsorship(work_auth);
    updateProfile({
      work_auth,
      requires_sponsorship: sponsorship ?? profile.requires_sponsorship,
    });
  };

  const handleClassYearChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    updateProfile({ current_class_year: e.target.value });
  };

  const handleCategoryToggle = (cat: string): void => {
    const current = profile.target_categories;
    const next = current.includes(cat)
      ? current.filter((c) => c !== cat)
      : [...current, cat];
    updateProfile({ target_categories: next });
    void recomputeAll(db, { ...profile, target_categories: next });
  };

  const handleResetProfile = (): void => {
    clearProfile();
    window.location.reload();
  };

  return (
    <Section title="Profile">
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700 dark:text-nj-text-dim">
            Graduation
          </span>
          <input
            type="month"
            value={profile.graduation}
            onChange={handleGraduationChange}
            className="mt-1 block w-full rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nj-accent"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-gray-700 dark:text-nj-text-dim">
            Class year
          </span>
          <select
            value={profile.current_class_year}
            onChange={handleClassYearChange}
            className="mt-1 block w-full rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nj-accent"
          >
            {CLASS_YEAR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-sm font-medium text-gray-700 dark:text-nj-text-dim">
          Work authorization
        </span>
        <select
          value={profile.work_auth}
          onChange={handleWorkAuthChange}
          className="mt-1 block w-full rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nj-accent"
        >
          {WORK_AUTH_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500 dark:text-nj-muted">
          Sponsorship required: {profile.requires_sponsorship ? 'Yes' : 'No'}
        </p>
      </label>

      <div>
        <span className="text-sm font-medium text-gray-700 dark:text-nj-text-dim">
          Target categories
        </span>
        <div className="mt-2 space-y-3">
          {CATEGORY_GROUPS.map((group) => (
            <fieldset key={group.label}>
              <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-nj-muted">
                {group.label}
              </legend>
              <div className="flex flex-wrap gap-2">
                {group.options.map((opt) => {
                  const active = profile.target_categories.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => handleCategoryToggle(opt.value)}
                      className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                        active
                          ? 'bg-nj-accent text-white'
                          : 'bg-gray-100 dark:bg-nj-border text-gray-600 dark:text-nj-text-dim hover:bg-gray-200 dark:hover:bg-nj-surface'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      </div>

      <div className="border-t border-gray-100 dark:border-nj-border pt-4">
        {!showWizardConfirm ? (
          <button
            type="button"
            onClick={() => setShowWizardConfirm(true)}
            className="text-sm text-nj-accent hover:text-nj-accent-bright transition-colors"
          >
            Re-run profile setup wizard
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-600 dark:text-nj-text-dim">
              This will reset your profile and open the setup wizard. Continue?
            </p>
            <button
              type="button"
              onClick={handleResetProfile}
              className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => setShowWizardConfirm(false)}
              className="text-sm text-gray-500 dark:text-nj-muted hover:text-gray-700 dark:hover:text-nj-text"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

/* ── Notifications (placeholder) ────────────────────── */

function NotificationsSection(): ReactNode {
  return (
    <Section title="Notifications">
      <p className="text-sm text-gray-500 dark:text-nj-muted">
        Notification preferences will be available in a future update. New posting notifications
        are currently enabled by default.
      </p>
    </Section>
  );
}

/* ── Data ───────────────────────────────────────────── */

function DataSection(): ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(
    async (type: 'csv' | 'json' | 'postings') => {
      setExporting(true);
      try {
        let content: string;
        let defaultName: string;
        let filters: { name: string; extensions: string[] }[];

        if (type === 'csv') {
          content = await exportApplicationsCSV(db);
          defaultName = `nightjar-applications-${new Date().toISOString().slice(0, 10)}.csv`;
          filters = [{ name: 'CSV', extensions: ['csv'] }];
        } else if (type === 'json') {
          content = await exportApplicationsJSON(db);
          defaultName = `nightjar-applications-${new Date().toISOString().slice(0, 10)}.json`;
          filters = [{ name: 'JSON', extensions: ['json'] }];
        } else {
          content = await exportPostingsJSON(db);
          defaultName = `nightjar-postings-backup-${new Date().toISOString().slice(0, 10)}.json`;
          filters = [{ name: 'JSON', extensions: ['json'] }];
        }

        const result = await saveFile({ content, defaultName, filters });
        if (result) {
          toast(`Exported to ${result}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        toast(`Export failed: ${msg}`, 'error');
      } finally {
        setExporting(false);
      }
    },
    [db, toast],
  );

  const handleClearData = useCallback(() => {
    localStorage.clear();
    if ('indexedDB' in window) {
      void indexedDB.deleteDatabase('nightjar-db');
    }
    window.location.reload();
  }, []);

  const exportButtonClass =
    'rounded-md border border-gray-300 dark:border-nj-border px-3 py-1.5 text-sm text-gray-700 dark:text-nj-text hover:bg-gray-50 dark:hover:bg-nj-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <Section title="Data">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-nj-text">Export applications</p>
            <p className="text-xs text-gray-500 dark:text-nj-muted">
              Download your application data as CSV or JSON
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={exporting}
              onClick={() => void handleExport('csv')}
              className={exportButtonClass}
            >
              CSV
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => void handleExport('json')}
              className={exportButtonClass}
            >
              JSON
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-nj-text">Export all postings</p>
            <p className="text-xs text-gray-500 dark:text-nj-muted">
              Full backup of cached postings with scores and classifications
            </p>
          </div>
          <button
            type="button"
            disabled={exporting}
            onClick={() => void handleExport('postings')}
            className={exportButtonClass}
          >
            JSON
          </button>
        </div>

        {exporting && (
          <p className="text-xs text-gray-500 dark:text-nj-muted flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Exporting…
          </p>
        )}
      </div>

      {isTauri() && (
        <div className="border-t border-gray-100 dark:border-nj-border pt-4">
          <p className="text-sm text-gray-500 dark:text-nj-muted">
            Database: <code className="text-xs bg-gray-100 dark:bg-nj-bg px-1.5 py-0.5 rounded">nightjar.db</code> in
            app data directory
          </p>
        </div>
      )}

      {!isTauri() && (
        <div className="border-t border-gray-100 dark:border-nj-border pt-4">
          <p className="text-sm text-gray-500 dark:text-nj-muted">
            Database stored in browser IndexedDB. Data persists across sessions but is
            browser-specific.
          </p>
        </div>
      )}

      <div className="border-t border-gray-100 dark:border-nj-border pt-4">
        {!showClearConfirm ? (
          <button
            type="button"
            onClick={() => setShowClearConfirm(true)}
            className="text-sm text-red-600 hover:text-red-700 transition-colors"
          >
            Clear all local data
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-600 dark:text-red-400 font-medium">
              This will permanently delete all local data including your profile, cached postings,
              application history, and preferences. This cannot be undone.
            </p>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder='Type "delete" to confirm'
                className="rounded-md border border-red-300 dark:border-red-800 bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-red-500 w-48"
              />
              <button
                type="button"
                disabled={confirmText !== 'delete'}
                onClick={handleClearData}
                className={`rounded-md px-3 py-1.5 text-sm font-medium text-white transition-colors ${
                  confirmText === 'delete'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-red-300 dark:bg-red-900 cursor-not-allowed'
                }`}
              >
                Delete everything
              </button>
              <button
                type="button"
                onClick={() => { setShowClearConfirm(false); setConfirmText(''); }}
                className="text-sm text-gray-500 dark:text-nj-muted hover:text-gray-700 dark:hover:text-nj-text"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

/* ── Shared components ──────────────────────────────── */

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500 dark:text-nj-muted">
        {title}
      </h2>
      <div className="rounded-lg border border-gray-200 dark:border-nj-border bg-white dark:bg-nj-surface p-4 space-y-4">
        {children}
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}): ReactNode {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-nj-text">{label}</p>
        <p className="text-xs text-gray-500 dark:text-nj-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={onChange}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-nj-accent focus-visible:ring-offset-2 dark:focus-visible:ring-offset-nj-bg ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        } ${checked ? 'bg-nj-accent' : 'bg-gray-200 dark:bg-nj-border'}`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
