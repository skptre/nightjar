import { useDatabase } from '@/providers/DatabaseProvider';
import { isTauri } from '@/lib/platform';
import { saveRecoveryCopy } from '@/backup/recovery';
import { Glyph } from '@/components/Icon';
import { APP_VERSION, checkForUpdates, installUpdate, useUpdater } from './updater';
import { withWorkspacePaused } from '@/lib/maintenance';

export function UpdateSection(): React.ReactNode {
  const { db } = useDatabase(); const update = useUpdater();
  const busy = ['checking', 'backing-up', 'downloading', 'installing'].includes(update.phase);
  const notes = update.notes.split('\n').map(line => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 6);
  return <section data-sec="updates" id="updates" aria-labelledby="updates-heading">
    <h2 id="updates-heading" className="h2">Updates</h2>
    <p className="dsc" style={{ marginBottom: 18 }}>{isTauri() ? 'Nightjar checks when it opens and every six hours. You decide when to install.' : 'App updates come with the installed desktop version.'}</p>
    <div className="srow">
      <div><div className="lbl">Nightjar {APP_VERSION}</div>
        <div className="dsc">{update.phase === 'checking' ? 'Looking for a newer version…' : update.message || 'Up to date as far as we know.'}{update.progress !== null && ` ${String(update.progress)}%`}</div></div>
      {isTauri() && <button type="button" className="ghost sm" disabled={busy} onClick={() => void checkForUpdates()}>
        {update.phase === 'checking' && <Glyph name="spin" size={13} width={1.8} className="spin" />}
        {update.phase === 'checking' ? 'Checking…' : update.phase === 'available' ? 'Check again' : 'Check for updates'}
      </button>}
    </div>
    <div className="exp" style={{ gridTemplateRows: update.phase === 'available' ? '1fr' : '0fr' }}><div>
      {update.phase === 'available' && <div className="confirm-box" style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Nightjar {update.version} is ready</div>
        {notes.length > 0 && <ul className="notes-list">{notes.map((line, i) => <li key={i}>{line}</li>)}</ul>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4, flexWrap: 'wrap' }}>
          <button type="button" className="solid sm" onClick={() => void withWorkspacePaused(() => installUpdate(() => saveRecoveryCopy(db, 'before-update')))}>Update and restart</button>
          <span className="dim" style={{ fontSize: 13 }}>A recovery copy is saved first.</span>
        </div>
      </div>}
    </div></div>
  </section>;
}
