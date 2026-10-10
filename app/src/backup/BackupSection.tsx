import { useRef, useState } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { saveFile } from '@/export/file-save';
import { Glyph } from '@/components/Icon';
import { createWorkspaceBackup, MAX_BACKUP_BYTES, parseWorkspaceBackup, restoreWorkspace, type WorkspaceBackup } from './workspace';
import { loadRecoveryCopy, saveRecoveryCopy, type RecoveryReason } from './recovery';
import { withWorkspacePaused } from '@/lib/maintenance';

const COPIES: [RecoveryReason, string, string][] = [
  ['daily', 'Latest automatic copy', 'Saved every hour while Nightjar is open'],
  ['before-update', 'Before last update', 'Saved before an update installs'],
  ['before-restore', 'Before last restore', 'Saved before a restore replaces your workspace'],
];

export function BackupSection(): React.ReactNode {
  const { db } = useDatabase();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ backup: WorkspaceBackup; from: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [savedName, setSavedName] = useState<string | null>(null);
  const run = async (key: string, operation: () => Promise<void>): Promise<void> => {
    setBusy(key); setMessage('');
    try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Backup operation failed. Please try again.'); }
    finally { setBusy(null); }
  };
  return <section data-sec="workspace" id="workspace" aria-labelledby="backup-heading">
    <h2 id="backup-heading" className="h2">Workspace and backups</h2>
    <p className="dsc" style={{ marginBottom: 18 }}>Your profile, tracker, notes and watched companies live here. Back them up to move or recover.</p>
    <div className="srow">
      <div><div className="lbl">Save a backup</div>
        <div className="dsc">{savedName ? `Saved ${savedName} just now.` : 'One file with everything you need to start again on another computer.'}</div></div>
      <button type="button" className="ghost sm" aria-label="Save workspace backup" disabled={busy !== null} onClick={() => void run('save', async () => {
        const name = `nightjar-workspace-${new Date().toISOString().slice(0, 10)}.json`;
        const path = await saveFile({ content: await createWorkspaceBackup(db), defaultName: name, filters: [{ name: 'Nightjar workspace', extensions: ['json'] }] });
        if (path) setSavedName(name);
      })}>{busy === 'save' && <Glyph name="spin" size={13} width={1.8} className="spin" />}{busy === 'save' ? 'Saving…' : 'Save backup'}</button>
    </div>
    <div className="srow stack">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
        <div><div className="lbl">Restore</div><div className="dsc">From a backup file, or from a copy Nightjar saved for you.</div></div>
        <button type="button" className="ghost sm" disabled={busy !== null} onClick={() => input.current?.click()}>Choose file…</button>
      </div>
      <div className="boxlist">{COPIES.map(([reason, label, when]) => <div key={reason}>
        <Glyph name="clock" size={15} width={1.5} style={{ opacity: 0.55 }} />
        <div style={{ flexGrow: 1 }}><div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div><div className="dim" style={{ fontSize: 13 }}>{when}</div></div>
        <button type="button" className="ghost" style={{ height: 32, fontSize: 13 }} disabled={busy !== null} onClick={() => { setPreview(null); void run(reason, async () => {
          try { setPreview({ backup: parseWorkspaceBackup(await loadRecoveryCopy(reason)), from: label.toLowerCase() }); }
          catch { throw new Error('There’s no copy like that on this device yet.'); }
        }); }}>{busy === reason ? 'Opening…' : 'Review'}</button>
      </div>)}</div>
      <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="Workspace backup file" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; setPreview(null);
        if (file) void run('file', async () => {
          if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 256 MB limit.');
          const backup = parseWorkspaceBackup(await file.text());
          setPreview({ backup, from: `the backup from ${new Date(backup.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` });
        });
      }} />
      <div className="exp" style={{ gridTemplateRows: preview ? '1fr' : '0fr' }}><div>
        {preview && <div className="confirm-box">
          <div style={{ fontSize: 15, fontWeight: 600 }}>Restore {preview.from}?</div>
          <div className="dsc" style={{ margin: 0 }}>{preview.backup.tables.applications.length} applications and {preview.backup.tables.application_outcome_events.length} history events. This replaces your tracker and preferences; saved job listings stay. A recovery copy of your current workspace is saved first.</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button type="button" className="solid sm" disabled={busy !== null} onClick={() => void run('restore', async () => {
              await withWorkspacePaused(async () => {
                await saveRecoveryCopy(db, 'before-restore');
                await restoreWorkspace(db, preview.backup);
              });
              window.location.reload();
            })}>{busy === 'restore' ? 'Restoring…' : 'Restore and reload'}</button>
            <button type="button" className="ghost sm" disabled={busy === 'restore'} onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>}
      </div></div>
    </div>
    {message && <p role="status" className="dsc" style={{ color: 'var(--danger)' }}>{message}</p>}
    <p className="dim" style={{ margin: '14px 0 0', fontSize: 13 }}>Backups contain personal information. Keep them somewhere private.</p>
  </section>;
}
