import { isTauri } from '@/lib/platform';
import type { Database } from './types';
export { NightjarDB } from './sqljs-database';
export type { Database, SqlValue } from './types';

let openingDatabase: Promise<Database> | undefined;

export function createDatabase(): Promise<Database> {
  // StrictMode mounts providers twice. Both callers must share schema initialization.
  openingDatabase ??= openDatabase().finally(() => { openingDatabase = undefined; });
  return openingDatabase;
}

async function openDatabase(): Promise<Database> {
  if (isTauri()) {
    const { TauriDatabase } = await import('./tauri-database');
    const db = await TauriDatabase.create();
    const { migrateFromBrowser } = await import('./migrate-from-browser');
    await migrateFromBrowser(db);
    return db;
  }
  const { BrowserDatabase } = await import('./browser-database');
  return BrowserDatabase.create();
}
