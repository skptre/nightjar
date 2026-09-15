import { useRef, useState } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { saveFile } from '@/export/file-save';
import { createWorkspaceBackup, MAX_BACKUP_BYTES, parseWorkspaceBackup, restoreWorkspace, type WorkspaceBackup } from './workspace';
import { loadRecoveryCopy, saveRecoveryCopy, type RecoveryReason } from './recovery';
import { withWorkspacePaused } from '@/lib/maintenance';

export function BackupSection(): React.ReactNode {
  const { db } = useDatabase();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<WorkspaceBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('');
    try { await operation(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Backup operation failed. Please try again.'); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4" aria-labelledby="backup-heading">
    <h2 id="backup-heading" className="section-label">Workspace & recovery</h2>
    <p className="text-sm">Your profile, applications, notes and followed companies stay on this device. Save a backup to move or recover your workspace.</p>
    <p className="home-note !mt-1">Backup files contain your personal information. Keep them somewhere private.</p>
    <div className="flex flex-wrap gap-3">
      <button className="button-secondary" disabled={busy} onClick={() => void run(async () => {
        const path = await saveFile({ content: await createWorkspaceBackup(db), defaultName: `nightjar-workspace-${new Date().toISOString().slice(0,10)}.json`, filters: [{name:'Nightjar workspace',extensions:['json']}] });
        if (path) setMessage('Workspace backup saved.');
      })}>Save workspace backup</button>
      <button className="button-secondary" disabled={busy} onClick={() => input.current?.click()}>Restore backup</button>
      <button className="button-secondary" disabled={busy} onClick={() => void run(async () => {
        const location = await saveRecoveryCopy(db, 'daily'); setMessage(`Recovery copy saved: ${location}`);
      })}>Save recovery copy</button>
    </div>
    <details><summary>Recover an automatic copy</summary><div className="flex flex-wrap gap-3 mt-3">
      {([['daily','Latest automatic copy'],['before-update','Before last update'],['before-restore','Before last restore']] as [RecoveryReason,string][]).map(([reason,label]) =>
        <button className="button-secondary" disabled={busy} key={reason} onClick={() => { setPreview(null); void run(async () => setPreview(parseWorkspaceBackup(await loadRecoveryCopy(reason)))); }}>{label}</button>)}
    </div></details>
    <input ref={input} type="file" accept=".json,application/json" className="sr-only" aria-label="Workspace backup file" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; setPreview(null);
      if (file) void run(async () => {
        if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup exceeds the 60 MB limit.');
        setPreview(parseWorkspaceBackup(await file.text()));
      });
    }} />
    {preview && <div className="rounded border border-nj-border p-4 space-y-3">
      <h3>Restore workspace from {new Date(preview.created_at).toLocaleString()}?</h3>
      <p className="text-sm">{preview.tables.applications.length} tracked applications and {preview.tables.application_outcome_events.length} history events. This replaces your tracker and preferences. Cached jobs are retained. A recovery copy of your current workspace is saved first.</p>
      <div className="flex gap-3"><button className="button-primary" disabled={busy} onClick={() => void run(async () => {
        await withWorkspacePaused(async () => {
          await saveRecoveryCopy(db, 'before-restore');
          await restoreWorkspace(db, preview);
        });
        window.location.reload();
      })}>{busy ? 'Restoring…' : 'Restore and reload'}</button><button className="button-secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel</button></div>
    </div>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>;
}
