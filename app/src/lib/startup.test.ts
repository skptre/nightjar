import { beforeEach, expect, it } from 'vitest';
import { restoreDestination } from './startup';
beforeEach(() => { localStorage.clear(); window.history.replaceState(null,'','/'); });
it('preserves all personal settings and opens Home on launch', () => {
  localStorage.setItem('nightjar_profile', '{"graduation":"2027-05"}');
  localStorage.setItem('nightjar_onboarding_dismissed','true');
  localStorage.setItem('nightjar_last_destination','/applications');
  const before = {...localStorage}; restoreDestination();
  expect({...localStorage}).toEqual(before); expect(window.location.pathname).toBe('/');
});
it('does not replace an incoming job link', () => {
  window.history.replaceState(null,'','/jobs?company=acme'); restoreDestination();
  expect(window.location.search).toBe('?company=acme');
});
