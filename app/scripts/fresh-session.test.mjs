import { afterEach, expect, it } from 'vitest';
import { clearOwnedStorage } from '@/db/clear-local-data';
afterEach(() => { localStorage.clear(); });
it('clears only Nightjar preferences and feed overrides when reset', () => {
  localStorage.setItem('nightjar_profile', '{}');
  localStorage.setItem('nightjar_feed_url_override', 'https://old.example');
  localStorage.setItem('unrelated_app', 'keep');
  clearOwnedStorage(localStorage);
  expect(localStorage.getItem('nightjar_profile')).toBeNull();
  expect(localStorage.getItem('nightjar_feed_url_override')).toBeNull();
  expect(localStorage.getItem('unrelated_app')).toBe('keep');
});
