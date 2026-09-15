import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setDensity, setTheme, useDensity, useAppearance } from './useAppearance';
afterEach(() => { cleanup(); localStorage.clear(); });
it('updates mounted consumers and persists both appearance settings', () => {
  const density=renderHook(useDensity); const theme=renderHook(useAppearance);
  act(() => { setDensity('compact'); setTheme('light'); });
  expect(density.result.current).toBe('compact'); expect(theme.result.current).toBe('light');
  expect(document.documentElement.dataset.density).toBe('compact');
  expect(localStorage.getItem('nightjar_density')).toBe('compact');
  expect(document.documentElement.classList.contains('dark')).toBe(false);
});
