import { useDatabase } from '@/providers/DatabaseProvider';
import { isTauri } from '@/lib/platform';
import { saveRecoveryCopy } from '@/backup/recovery';
import { APP_VERSION, checkForUpdates, installUpdate, useUpdater } from './updater';
import { withWorkspacePaused } from '@/lib/maintenance';
export function UpdateSection(): React.ReactNode {
  const { db } = useDatabase(); const update = useUpdater();
  const busy = ['checking','backing-up','downloading','installing'].includes(update.phase);
  return <section className="space-y-3" aria-labelledby="updates-heading">
    <h2 id="updates-heading" className="section-label">App updates</h2>
    <p className="text-sm">Nightjar {APP_VERSION}</p>
    {isTauri() ? <>
      <p className="home-note !mt-1">Nightjar checks when you open it and every six hours while running. You choose when to install. A recovery copy is saved first.</p>
      <div className="flex flex-wrap gap-3"><button className="button-secondary" disabled={busy} onClick={() => void checkForUpdates()}>{update.phase === 'checking' ? 'Checking…' : 'Check for updates'}</button>
      {update.phase === 'available' && <button className="button-primary" onClick={() => void withWorkspacePaused(() => installUpdate(() => saveRecoveryCopy(db,'before-update')))}>Update to {update.version} and restart</button>}</div>
      {update.notes && <details><summary>What’s new in {update.version}</summary><p className="whitespace-pre-wrap text-sm mt-3">{update.notes}</p></details>}
      {update.message && <p role="status" className="text-sm">{update.message}{update.progress !== null && ` ${update.progress}%`}</p>}
    </> : <p className="text-sm">App updates are available in the installed desktop version.</p>}
  </section>;
}
