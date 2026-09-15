import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDatabase } from '@/providers/DatabaseProvider';
import { saveRecoveryCopy } from '@/backup/recovery';
import { isTauri } from '@/lib/platform';
import { checkForUpdates, useUpdater } from '@/updates/updater';
import { maintenanceActive, trackWorkspaceTask, useWorkspacePaused } from '@/lib/maintenance';

export function WorkspaceServices(): React.ReactNode {
  const { db } = useDatabase(); const update = useUpdater();
  const paused = useWorkspacePaused();
  const [saveError, setSaveError] = useState(false);
  const [backupError, setBackupError] = useState(false);
  useEffect(() => {
    const failed = (): void => setSaveError(true);
    window.addEventListener('nightjar:save-error', failed);
    return () => window.removeEventListener('nightjar:save-error', failed);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    const timer = setTimeout(() => void checkForUpdates(), 10000);
    const interval = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, []);
  useEffect(() => {
    let running = false; let disposed = false;
    const backup = async (): Promise<void> => {
      if (running || maintenanceActive()) return; running = true;
      try { await trackWorkspaceTask(saveRecoveryCopy(db, 'daily')); if (!disposed) setBackupError(false); }
      catch { if (!disposed) setBackupError(true); }
      finally { running = false; }
    };
    const timer = setTimeout(() => void backup(), 60000);
    const interval = setInterval(() => void backup(), 60 * 60 * 1000);
    return () => { disposed = true; clearTimeout(timer); clearInterval(interval); };
  }, [db]);
  return <>
    {paused && !['backing-up','downloading','installing'].includes(update.phase) && <div className="update-overlay" role="alert" aria-busy="true"><p>Updating your workspace. Please keep Nightjar open…</p></div>}
    {saveError && <div className="connection-notice" role="alert">A change could not be saved. Keep Nightjar open and save a workspace backup in <Link to="/settings">Settings</Link> before restarting.</div>}
    {backupError && <div className="connection-notice" role="alert">The automatic recovery copy could not be saved. Your workspace is still here. <Link to="/settings">Check backups in Settings</Link>.</div>}
    {update.phase === 'available' && <div className="connection-notice" role="status">Nightjar {update.version} is available. <Link to="/settings">Review update</Link></div>}
    {['backing-up','downloading','installing'].includes(update.phase) && <div className="update-overlay" role="alert" aria-busy="true"><div><h2>Updating Nightjar</h2><p>{update.message}</p>{update.progress !== null && <progress max={100} value={update.progress} />}</div></div>}
  </>;
}
