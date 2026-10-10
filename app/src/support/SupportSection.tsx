import { useState } from 'react';
import { useSync } from '@/providers/SyncProvider';
import { useDatabase } from '@/providers/DatabaseProvider';
import { saveFile } from '@/export/file-save';
import { openExternal, isTauri } from '@/lib/platform';
import { APP_VERSION } from '@/updates/updater';
import { getFeedFreshness } from '@/sync/feed-sync';
import { Glyph } from '@/components/Icon';

export function issueUrl(postingId?: string): string {
  const id = postingId && /^[a-f0-9]{16}$/.test(postingId) ? `\nPosting ID: ${postingId}` : '';
  const body = `Nightjar version: ${APP_VERSION}${id}\n\nWhat happened?\n\nWhat did you expect?\n\nSteps to reproduce:\n\nPlease omit personal notes, contact details, and workspace backups.`;
  return `https://github.com/skptre/nightjar/issues/new?body=${encodeURIComponent(body)}`;
}

function when(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function SupportSection({ onDone }: { onDone?: (message: string) => void }): React.ReactNode {
  const { db } = useDatabase(); const sync = useSync(); const freshness = getFeedFreshness();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const checked = when(sync.lastSyncedAt);
  const published = freshness.updatedAt && Number.isFinite(Date.parse(freshness.updatedAt))
    ? new Date(freshness.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const say = (text: string): void => { setMessage(text); onDone?.(text); };
  return <section data-sec="support" id="support" aria-labelledby="support-heading">
    <h2 id="support-heading" className="h2">Jobs and support</h2>
    <p className="dsc" style={{ marginBottom: 18 }}>Where your jobs come from, and how to reach us when something’s off.</p>
    <div className="srow">
      <div><div className="lbl">Job feed</div>
        <div className="dsc">{checked ? `Last checked ${checked}.` : 'Not checked yet.'}{published ? ` Feed published ${published}.` : ''}{freshness.source === 'bundled' ? ' Included with this version.' : ''}</div></div>
      <button type="button" className="ghost sm" disabled={sync.status === 'syncing'} onClick={() => void sync.refreshJobs()}>
        {sync.status === 'syncing' && <Glyph name="spin" size={13} width={1.8} className="spin" />}{sync.status === 'syncing' ? 'Checking…' : 'Check now'}
      </button>
    </div>
    <div className="srow">
      <div><div className="lbl">Report a problem</div><div className="dsc">Opens a prefilled issue on GitHub. Leave out personal notes and backups.</div></div>
      <button type="button" className="ghost sm" onClick={() => void openExternal(issueUrl()).then(ok => { if (!ok) say('Could not open GitHub. Try again.'); })}>
        Open GitHub <Glyph name="ext" size={12} />
      </button>
    </div>
    <div className="srow">
      <div><div className="lbl">Diagnostics</div><div className="dsc">App version, database version, job count and feed status. Nothing personal.</div></div>
      <button type="button" className="ghost sm" disabled={busy} onClick={() => {
        setBusy(true); setMessage('');
        void (async () => {
          const schema = await db.queryOne<{ version: number }>('SELECT version FROM schema_version');
          const jobs = await db.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM postings_cache');
          const content = JSON.stringify({ app_version: APP_VERSION, runtime: isTauri() ? 'desktop' : 'browser', schema_version: schema?.version, cached_jobs: jobs?.count,
            feed_source: freshness.source, feed_published_at: freshness.updatedAt, last_checked_at: sync.lastSyncedAt, sync_status: sync.status }, null, 2);
          if (await saveFile({ content, defaultName: 'nightjar-diagnostics.json', filters: [{ name: 'Diagnostics', extensions: ['json'] }] })) say('Diagnostics saved. Review them before attaching.');
        })().catch(() => say('Could not save diagnostics. Please try again.')).finally(() => setBusy(false));
      }}>Save diagnostics</button>
    </div>
    {message && !onDone && <p role="status" className="dsc">{message}</p>}
  </section>;
}
