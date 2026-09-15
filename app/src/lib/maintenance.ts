import { useSyncExternalStore } from 'react';
let paused = false;
const listeners = new Set<() => void>();
function notify(): void { listeners.forEach(fn => fn()); }
export function useWorkspacePaused(): boolean {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => paused);
}
const active = new Set<Promise<unknown>>();
export function maintenanceActive(): boolean { return paused; }
export function trackWorkspaceTask<T>(task: Promise<T>): Promise<T> {
  active.add(task); void task.finally(() => active.delete(task)).catch(() => undefined); return task;
}
export async function withWorkspacePaused<T>(operation: () => Promise<T>): Promise<T> {
  if (paused) throw new Error('Another workspace operation is in progress. Please wait.');
  paused = true;
  notify();
  try { await Promise.allSettled([...active]); return await operation(); }
  finally { paused = false; notify(); }
}
