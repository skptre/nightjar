import { applyAppearance, setTheme, useAppearance, type Theme } from '@/hooks/useAppearance';
import { Icon } from '@/components/Icon';
import { requestNotificationPermission } from '@/sync/notifications';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { useProfile } from '@/providers/ProfileProvider';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useToast } from '@/components/Toast';
import { isTauri, GMAIL_ENABLED } from '@/lib/platform';
import {
  WORK_AUTH_OPTIONS,
  DEGREE_TYPE_OPTIONS,
  type DegreeType,
  CATEGORY_GROUPS,
  computeGradWindow,
  inferRequiresSponsorship,
} from '@/profile/types';
import { exportApplicationsCSV } from '@/export/export-csv';
import { exportApplicationsJSON } from '@/export/export-json';
import { exportPostingsJSON } from '@/export/export-postings';
import { saveFile } from '@/export/file-save';
import { recomputeAll } from '@/classify/recompute';
import type { GmailAuthState } from '@/integrations/types';
import { getAuthState, startOAuthFlow, disconnectGmail } from '@/integrations/gmail-auth';
import { clearAllGmailData } from '@/integrations/gmail-service';
import { clearAllLocalData } from '@/db/clear-local-data';

export function SettingsView(): ReactNode {
  return (
    <div className="settings-page space-y-8 pb-12">
      <div className="page-heading"><p className="eyebrow">MAKE YOURSELF AT HOME</p><h1>Settings<span className="accent-dot">.</span></h1><p>Your workspace, the way you like it.</p></div>
      <GeneralSection />
      <AppearanceSection />
      <AlertsSection />
      <ProfileSection />
      {GMAIL_ENABLED && isTauri() && <GmailSection />}
      <DataSection />
    </div>
  );
}

/* ── General ────────────────────────────────────────── */

function GeneralSection(): ReactNode {
  if (!isTauri()) return null;

  return (
    <Section title="General">
      <AutoLaunchRow />
      <div className="border-t border-gray-100 pt-4">
        <p className="text-sm text-gray-500">
          Closing the window minimizes Nightjar to the system tray. Use the tray icon or
          &ldquo;Quit&rdquo; from the tray menu to exit completely.
        </p>
      </div>
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

function AppearanceSection(): ReactNode {
  const theme = useAppearance();
  const [density, setDensity] = useState(() => localStorage.getItem('nightjar_density') ?? 'comfortable');
  return <Section title="Appearance">
    <div className="appearance-row"><div><p className="text-sm">Theme</p><p className="home-note !mt-1">A comfortable view, day or night.</p></div>
      <div className="segmented" aria-label="Theme">{(['dark','light','system'] as Theme[]).map(value => <button key={value} aria-pressed={theme === value} onClick={() => setTheme(value)}><span className="flex items-center gap-2"><Icon name={value === 'dark' ? 'moon' : value === 'light' ? 'sun' : 'settings'} size={14} />{value[0]!.toUpperCase() + value.slice(1)}</span></button>)}</div>
    </div>
    <div className="appearance-row"><div><p className="text-sm">Tracker rows</p><p className="home-note !mt-1">Choose how much room your applications have.</p></div>
      <div className="segmented" aria-label="Tracker density">{['comfortable','compact'].map(value => <button key={value} aria-pressed={density === value} onClick={() => { localStorage.setItem('nightjar_density',value); setDensity(value); applyAppearance(); }}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
    </div>
  </Section>;
}

function AlertsSection(): ReactNode {
  const watched = useWatchlist();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(() => localStorage.getItem('nightjar_watch_alerts') === 'true');
  const [busy, setBusy] = useState(false);
  return <Section title="Alerts"><div className="appearance-row"><div><p className="text-sm">Watched companies</p>
    <p className="home-note !mt-1">One bundled heads-up when new roles arrive while Nightjar is open in the background.</p>
    <p className="home-note !mt-1">{watched.length} companies followed. Updates also stay on Home.</p></div>
    <button className="button-secondary" disabled={busy || (!enabled && watched.length === 0)} onClick={() => {
      if (enabled) { localStorage.setItem('nightjar_watch_alerts', 'false'); setEnabled(false); return; }
      setBusy(true);
      void requestNotificationPermission().then(permission => {
        if (permission === 'granted') { localStorage.setItem('nightjar_watch_alerts', 'true'); setEnabled(true); }
        else toast('Alerts are not enabled. You can allow notifications in your browser or device settings.', 'info');
      }).catch(() => toast('Notifications are unavailable here. Your updates still appear on Home.', 'info')).finally(() => setBusy(false));
    }}>{busy ? 'Setting up…' : enabled ? 'Turn off alerts' : 'Set up alerts'}</button>
  </div></Section>;
}

function ProfileSection(): ReactNode {
  const { profile, updateProfile, beginProfileSetup } = useProfile();
  const { db } = useDatabase();
  const [showWizardConfirm, setShowWizardConfirm] = useState(false);

  if (!profile) {
    return (
      <Section title="Preferences">
        <div>
          <p className="text-sm font-medium text-gray-900">Narrow your jobs</p>
          <p className="mt-1 text-xs text-gray-500">
            Add optional graduation, authorization, field, and location preferences.
          </p>
        </div>
        <button
          type="button"
          onClick={beginProfileSetup}
          className="w-fit rounded-md bg-violet-700 px-4 py-2 text-sm font-medium text-white hover:bg-violet-800"
        >
          Personalize jobs
        </button>
      </Section>
    );
  }

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

  const handleCategoryToggle = (cat: string): void => {
    const current = profile.target_categories;
    const next = current.includes(cat)
      ? current.filter((c) => c !== cat)
      : [...current, cat];
    updateProfile({ target_categories: next });
    void recomputeAll(db, { ...profile, target_categories: next });
  };

  const handleResetProfile = (): void => {
    beginProfileSetup();
  };

  return (
    <Section title="Profile">
      <div className="max-w-xs">
        <label className="mb-4 block">
          <span className="text-sm font-medium text-gray-700 dark:text-nj-text-dim">
            Degree type
          </span>
          <select
            value={profile.degree_type ?? ''}
            onChange={(event) => {
              const degree_type = event.target.value as DegreeType;
              updateProfile({ degree_type });
              void recomputeAll(db, { ...profile, degree_type });
            }}
            className="mt-1 block w-full rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nj-accent"
          >
            <option value="" disabled>Select degree type</option>
            {DEGREE_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
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
            Edit preferences
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-600 dark:text-nj-text-dim">
              Open your preferences setup? Your applications and notes will stay here.
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

/* ── Gmail ──────────────────────────────────────────── */

function GmailSection(): ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const [authState, setAuthState] = useState<GmailAuthState>({
    connected: false,
    email: null,
    lastScanAt: null,
    error: null,
  });
  const [loading, setLoading] = useState(true);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [clientId, setClientIdState] = useState(() =>
    localStorage.getItem('nightjar_gmail_client_id') ?? '',
  );
  const [showClientId, setShowClientId] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAuthState().then((state) => {
      if (!cancelled) {
        setAuthState(state);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const handleConnect = useCallback(async () => {
    if (!clientId.trim()) {
      toast('Set a Gmail client ID first', 'error');
      setShowClientId(true);
      return;
    }
    setLoading(true);
    try {
      await startOAuthFlow();
      toast('OAuth flow started — complete sign-in in your browser');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start OAuth';
      toast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientId, toast]);

  const handleDisconnect = useCallback(async () => {
    setLoading(true);
    try {
      await disconnectGmail();
      await clearAllGmailData(db);
      setAuthState({ connected: false, email: null, lastScanAt: null, error: null });
      setShowDisconnectConfirm(false);
      toast('Gmail disconnected. All email data deleted.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to disconnect';
      toast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [db, toast]);

  const handleSaveClientId = useCallback(() => {
    const trimmed = clientId.trim();
    if (trimmed) {
      localStorage.setItem('nightjar_gmail_client_id', trimmed);
    } else {
      localStorage.removeItem('nightjar_gmail_client_id');
    }
    toast('Gmail client ID saved');
  }, [clientId, toast]);

  return (
    <Section title="Gmail Sync">
      <p className="text-sm text-gray-600 dark:text-nj-text-dim">
        Nightjar can scan your inbox for interview invitations, offers, and rejections from
        companies you&apos;ve applied to. Email content never leaves your computer — only message
        IDs are stored for deduplication.
      </p>

      {authState.connected ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
            <span className="text-sm text-gray-700 dark:text-nj-text">
              Connected{authState.email ? ` as ${authState.email}` : ''}
            </span>
          </div>
          {authState.lastScanAt && (
            <p className="text-xs text-gray-500 dark:text-nj-muted">
              Last scan: {new Date(authState.lastScanAt).toLocaleString()}
            </p>
          )}
          {!showDisconnectConfirm ? (
            <button
              type="button"
              onClick={() => setShowDisconnectConfirm(true)}
              disabled={loading}
              className="text-sm text-red-600 hover:text-red-700 transition-colors disabled:opacity-50"
            >
              Disconnect Gmail
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <p className="text-sm text-red-600 dark:text-red-400">
                This will revoke access and delete all email scan data.
              </p>
              <button
                type="button"
                onClick={() => void handleDisconnect()}
                disabled={loading}
                className="rounded-md bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setShowDisconnectConfirm(false)}
                className="text-sm text-gray-500 dark:text-nj-muted hover:text-gray-700 dark:hover:text-nj-text"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={loading}
            className="rounded-md bg-nj-accent px-4 py-2 text-sm font-medium text-white hover:bg-nj-accent-bright transition-colors disabled:opacity-50"
          >
            Connect Gmail
          </button>
          <p className="text-xs text-gray-500 dark:text-nj-muted">
            Read-only access (gmail.readonly). Nightjar never sends email.
          </p>
        </div>
      )}

      <div className="border-t border-gray-100 dark:border-nj-border pt-4">
        <button
          type="button"
          onClick={() => setShowClientId((p) => !p)}
          className="text-xs text-gray-400 dark:text-nj-muted hover:text-gray-600 dark:hover:text-nj-text transition-colors"
        >
          {showClientId ? 'Hide' : 'Show'} OAuth setup
        </button>
        {showClientId && (
          <div className="mt-3 space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim">
              Google OAuth Client ID
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientIdState(e.target.value)}
                placeholder="xxxx.apps.googleusercontent.com"
                className="flex-1 rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-bg text-sm text-gray-900 dark:text-nj-text px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-nj-accent"
              />
              <button
                type="button"
                onClick={handleSaveClientId}
                className="rounded-md bg-nj-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-nj-accent-bright transition-colors"
              >
                Save
              </button>
            </div>
            <p className="text-xs text-gray-400 dark:text-nj-muted">
              Create a Desktop OAuth client at console.cloud.google.com. Enable Gmail API. Add
              http://localhost:19847/oauth/callback as a redirect URI.
            </p>
          </div>
        )}
      </div>
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
  const [clearing, setClearing] = useState(false);

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

  const handleClearData = useCallback(async () => {
    setClearing(true);
    try {
      await clearAllLocalData(db);
      window.location.reload();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      toast(`Delete failed: ${message}`, 'error');
      setClearing(false);
    }
  }, [db, toast]);

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
              A copy of the job listings saved on this device
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
            Your tracker is saved in this browser. Export a copy before changing browsers or clearing browser data.
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
                disabled={confirmText !== 'delete' || clearing}
                onClick={() => void handleClearData()}
                className={`rounded-md px-3 py-1.5 text-sm font-medium text-white transition-colors ${
                  confirmText === 'delete'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-red-300 dark:bg-red-900 cursor-not-allowed'
                }`}
              >
                {clearing ? 'Deleting…' : 'Delete everything'}
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
      <div className="space-y-5">
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
