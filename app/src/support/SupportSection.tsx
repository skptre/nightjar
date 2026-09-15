import { useState } from 'react';
import { useSync } from '@/providers/SyncProvider';
import { useDatabase } from '@/providers/DatabaseProvider';
import { saveFile } from '@/export/file-save';
import { openExternal, isTauri } from '@/lib/platform';
import { APP_VERSION } from '@/updates/updater';
import { getFeedFreshness } from '@/sync/feed-sync';

export function issueUrl(postingId?: string): string {
  const id = postingId && /^[a-f0-9]{16}$/.test(postingId) ? `\nPosting ID: ${postingId}` : '';
  const body = `Nightjar version: ${APP_VERSION}${id}\n\nWhat happened?\n\nWhat did you expect?\n\nSteps to reproduce:\n\nPlease omit personal notes, contact details, and workspace backups.`;
  return `https://github.com/skptre/nightjar/issues/new?body=${encodeURIComponent(body)}`;
}
export function SupportSection(): React.ReactNode {
  const {db} = useDatabase(); const sync = useSync(); const freshness = getFeedFreshness();
  const [message,setMessage] = useState(''); const [busy,setBusy] = useState(false);
  const date = (value: string | null): string => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not yet available';
  return <section className="space-y-3" aria-labelledby="support-heading">
    <h2 id="support-heading" className="section-label">Jobs & support</h2>
    <p className="text-sm">Last successful check: {date(sync.lastSyncedAt)}</p>
    <p className="text-sm">Feed published: {date(freshness.updatedAt)}{freshness.source === 'bundled' ? ' · Included with this app version' : ''}</p>
    <p className="home-note !mt-1">Diagnostics include only the app version, database version, cached job count and feed status. They do not include your profile, tracker, notes, followed companies or credentials.</p>
    <div className="flex flex-wrap gap-3"><button className="button-secondary" disabled={sync.status === 'syncing'} onClick={() => void sync.refreshJobs()}>{sync.status === 'syncing' ? 'Checking jobs…' : 'Check for new jobs'}</button>
      <button className="button-secondary" onClick={() => void openExternal(issueUrl()).then(ok => { if (!ok) setMessage('Could not open GitHub. Try again.'); })}>Report a problem</button>
      <button className="button-secondary" disabled={busy} onClick={() => {
        setBusy(true); setMessage('');
        void (async () => {
          const schema = await db.queryOne<{version:number}>('SELECT version FROM schema_version');
          const jobs = await db.queryOne<{count:number}>('SELECT COUNT(*) AS count FROM postings_cache');
          const content = JSON.stringify({app_version:APP_VERSION, runtime:isTauri() ? 'desktop' : 'browser', schema_version:schema?.version, cached_jobs:jobs?.count,
            feed_source:freshness.source, feed_published_at:freshness.updatedAt, last_checked_at:sync.lastSyncedAt, sync_status:sync.status},null,2);
          if (await saveFile({content,defaultName:'nightjar-diagnostics.json',filters:[{name:'Diagnostics',extensions:['json']}]})) setMessage('Diagnostics saved. You can review them before attaching to a report.');
        })().catch(() => setMessage('Could not save diagnostics. Please try again.')).finally(() => setBusy(false));
      }}>Save diagnostics</button></div>
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
