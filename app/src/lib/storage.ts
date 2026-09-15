export function saveLocalValue(key: string, value: string): void {
  try { localStorage.setItem(key, value); }
  catch (error) { window.dispatchEvent(new Event('nightjar:save-error')); throw error; }
}
