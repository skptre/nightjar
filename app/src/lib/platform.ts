// Flip to true when Gmail OAuth callback server is implemented
export const GMAIL_ENABLED = false;

export function isTauri(): boolean {
  return typeof window !== 'undefined' &&
    '__TAURI_INTERNALS__' in window;
}

export async function openExternal(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external_url', { url: parsed.toString() });
      return true;
    } catch (error: unknown) {
      console.warn('[nightjar] could not open job link:', error);
      return false;
    }
  }

  return window.open(parsed.toString(), '_blank', 'noopener,noreferrer') !== null;
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
