import type { Database } from './types';
import { isTauri } from '@/lib/platform';
import { withWorkspacePaused } from '@/lib/maintenance';

const TABLES_IN_DELETE_ORDER = [
  'job_details_cache',
  'gmail_suggestions',
  'application_outcome_events',
  'recalibration_suggestion_actions',
  'applications',
  'postings_cache',
  'companies_meta',
] as const;

export function clearOwnedStorage(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith('nightjar_') || key === 'gmail_code_verifier') keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export async function clearAllLocalData(db: Database): Promise<void> {
  return withWorkspacePaused(() => clearWorkspace(db));
}
async function clearWorkspace(db: Database): Promise<void> {
  if (isTauri()) await (await import('@tauri-apps/api/core')).invoke('clear_recovery_copies');
  if (typeof indexedDB !== 'undefined') await (await import('./indexeddb')).clearRecoveryStorage();
  await db.transaction(async (transaction) => {
    const journal = await transaction.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_restore_journal'");
    if (journal) await transaction.run('DELETE FROM workspace_restore_journal');
    for (const table of TABLES_IN_DELETE_ORDER) {
      await transaction.run(`DELETE FROM ${table}`);
    }
  });
  clearOwnedStorage(localStorage);
  clearOwnedStorage(sessionStorage);
}
