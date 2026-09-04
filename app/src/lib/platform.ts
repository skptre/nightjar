// Flip to true when Gmail OAuth callback server is implemented
export const GMAIL_ENABLED = false;

export function isTauri(): boolean {
  return typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window;
}

export async function updateTrayInfo(lastSync: string, newCount: number): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('update_tray_info', { lastSync, newCount });
  } catch {
    // Tray update is best-effort
  }
}

export async function listenForTraySync(callback: () => void): Promise<(() => void) | null> {
  if (!isTauri()) return null;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen('trigger-sync', () => callback());
    return unlisten;
  } catch {
    return null;
  }
}
