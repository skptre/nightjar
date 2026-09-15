import type { Database } from '@/db/types';
import { isTauri } from '@/lib/platform';
import { createWorkspaceBackup } from './workspace';

export type RecoveryReason = 'daily' | 'before-update' | 'before-restore';
export async function loadRecoveryCopy(reason: RecoveryReason): Promise<string> {
  if (isTauri()) return (await import('@tauri-apps/api/core')).invoke<string>('load_recovery_copy', {reason});
  const { loadDatabase } = await import('@/db/indexeddb');
  const bytes = await loadDatabase(`workspace-${reason}`);
  if (!bytes) throw new Error('No recovery copy is available yet.');
  return new TextDecoder().decode(bytes);
}
export async function saveRecoveryCopy(db: Database, reason: RecoveryReason): Promise<string> {
  const content = await createWorkspaceBackup(db);
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('save_recovery_copy', { content, reason });
  }
  // Browser recovery copies use IndexedDB rather than quota-limited localStorage.
  const { saveDatabase } = await import('@/db/indexeddb');
  await saveDatabase(new TextEncoder().encode(content), `workspace-${reason}`);
  return 'Browser recovery storage';
}
