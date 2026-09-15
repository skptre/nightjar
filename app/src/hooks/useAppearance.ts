import { useSyncExternalStore } from 'react';
import { saveLocalValue } from '@/lib/storage';
export type Theme = 'dark' | 'light' | 'system';
export type Density = 'comfortable' | 'compact';
const event = 'nightjar:appearance';
export function getTheme(): Theme {
  const value = localStorage.getItem('nightjar_theme');
  return value === 'light' || value === 'system' ? value : 'dark';
}
export function applyAppearance(): void {
  const theme = getTheme();
  document.documentElement.classList.toggle('dark', theme === 'dark'
    || (theme === 'system' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)));
  document.documentElement.dataset.density = localStorage.getItem('nightjar_density') ?? 'comfortable';
}
export function setTheme(theme: Theme): void {
  saveLocalValue('nightjar_theme', theme);
  applyAppearance();
  window.dispatchEvent(new Event(event));
}
function subscribe(callback: () => void): () => void {
  window.addEventListener(event, callback);
  window.addEventListener('storage', callback);
  return () => { window.removeEventListener(event, callback); window.removeEventListener('storage', callback); };
}
export function useAppearance(): Theme { return useSyncExternalStore(subscribe, getTheme); }
export function getDensity(): Density { return localStorage.getItem('nightjar_density') === 'compact' ? 'compact' : 'comfortable'; }
export function setDensity(density: Density): void {
  saveLocalValue('nightjar_density', density); applyAppearance(); window.dispatchEvent(new Event(event));
}
export function useDensity(): Density { return useSyncExternalStore(subscribe, getDensity); }
