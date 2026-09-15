import { useSyncExternalStore } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { isTauri } from '@/lib/platform';
import config from '../../src-tauri/tauri.conf.json';

export const APP_VERSION = config.version;
export interface UpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'backing-up' | 'downloading' | 'installing' | 'error';
  version: string | null; notes: string; progress: number | null; message: string;
}
let state: UpdateState = { phase: 'idle', version: null, notes: '', progress: null, message: '' };
let available: Update | null = null;
const listeners = new Set<() => void>();
const busy = (): boolean => ['checking','backing-up','downloading','installing'].includes(state.phase);
function set(patch: Partial<UpdateState>): void { state = { ...state, ...patch }; listeners.forEach(fn => fn()); }
export function useUpdater(): UpdateState {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
}
export async function checkForUpdates(): Promise<void> {
  if (!isTauri() || busy()) return;
  set({ phase: 'checking', message: '', progress: null });
  try {
    if (available) { await available.close(); available = null; }
    const { check } = await import('@tauri-apps/plugin-updater');
    available = await check({ timeout: 15000 });
    set({ phase: available ? 'available' : 'current', version: available?.version ?? null,
      notes: available?.body ?? '', message: available ? 'A new version is ready.' : 'You have the latest version.' });
  } catch {
    set({ phase: 'error', version: null, notes: '', message: 'Could not check for updates. Check your connection and try again.' });
  }
}
export async function installUpdate(backup: () => Promise<unknown>): Promise<void> {
  if (!available || busy()) return;
  set({ phase: 'backing-up', message: 'Saving a recovery copy…' });
  try { await backup(); }
  catch { set({ phase: 'error', message: 'Your recovery copy could not be saved. The update was cancelled. Free disk space and try again.' }); return; }
  let received = 0; let total = 0;
  try {
    set({ phase: 'downloading', message: 'Downloading and verifying the update…', progress: null });
    await available.download(event => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      if (event.event === 'Progress') { received += event.data.chunkLength; set({ progress: total ? Math.min(100, Math.round(100 * received / total)) : null }); }
    }, { timeout: 120000 });
    // The official plugin rejects invalid signatures before install is reached.
    set({ phase: 'installing', message: 'Installing. Nightjar will restart.' });
    await available.install();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch {
    set({ phase: 'error', message: 'The update could not be downloaded, verified, or installed. Your recovery copy is saved. Check for updates to retry.' });
  }
}
