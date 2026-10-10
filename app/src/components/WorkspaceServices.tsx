import { useEffect, useSyncExternalStore } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { saveRecoveryCopy } from '@/backup/recovery';
import { isTauri } from '@/lib/platform';
import { checkForUpdates, useUpdater } from '@/updates/updater';
import { maintenanceActive, trackWorkspaceTask, useWorkspacePaused } from '@/lib/maintenance';

// Save and backup failures surface as notices in the header area (see Layout).
interface WorkspaceNotices { saveError: boolean; backupError: boolean }
let notices: WorkspaceNotices = { saveError: false, backupError: false };
const listeners = new Set<() => void>();
function setNotices(patch: Partial<WorkspaceNotices>): void {
  notices = { ...notices, ...patch };
  listeners.forEach((listener) => listener());
}
export function useWorkspaceNotices(): WorkspaceNotices {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => notices);
}

export function WorkspaceServices(): React.ReactNode {
  const { db } = useDatabase(); const update = useUpdater();
  const paused = useWorkspacePaused();
  useEffect(() => {
    const failed = (): void => setNotices({ saveError: true });
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
      try { await trackWorkspaceTask(saveRecoveryCopy(db, 'daily')); if (!disposed) setNotices({ backupError: false }); }
      catch { if (!disposed) setNotices({ backupError: true }); }
      finally { running = false; }
    };
    const timer = setTimeout(() => void backup(), 60000);
    const interval = setInterval(() => void backup(), 60 * 60 * 1000);
    return () => { disposed = true; clearTimeout(timer); clearInterval(interval); };
  }, [db]);
  const installing = ['backing-up', 'downloading', 'installing'].includes(update.phase);
  // The app is covered while it installs or restores, so nothing changes mid-update.
  if (installing) {
    return <div className="update-overlay" role="alert" aria-busy="true"><div className="update-card">
      <h2>Updating Nightjar</h2>
      <p>{update.message || 'Keep Nightjar open.'}</p>
      <div className="bar"><div className={update.progress === null ? 'indet' : ''} style={update.progress === null ? undefined : { width: `${String(update.progress)}%` }} /></div>
      <p style={{ margin: '10px 0 0', fontSize: 13 }}>Nightjar restarts by itself when it’s done.</p>
    </div></div>;
  }
  if (paused) {
    return <div className="update-overlay" role="alert" aria-busy="true"><div className="update-card">
      <h2>Updating your workspace</h2>
      <p>Keep Nightjar open for a moment.</p>
      <div className="bar"><div className="indet" /></div>
    </div></div>;
  }
  return null;
}
