import type { Database } from './types';

const TABLES_IN_DELETE_ORDER = [
  'gmail_suggestions',
  'application_outcome_events',
  'recalibration_suggestion_actions',
  'applications',
  'postings_cache',
  'companies_meta',
] as const;

function clearOwnedStorage(storage: Storage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith('nightjar_') || key === 'gmail_code_verifier') keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

export async function clearAllLocalData(db: Database): Promise<void> {
  await db.transaction(async () => {
    for (const table of TABLES_IN_DELETE_ORDER) {
      await db.run(`DELETE FROM ${table}`);
    }
  });
  clearOwnedStorage(localStorage);
  clearOwnedStorage(sessionStorage);
}
