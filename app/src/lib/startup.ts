export function restoreDestination(): void {
  // Preserve deep links; only choose a destination for an ordinary launch.
  if (window.location.pathname !== '/' || window.location.search) return;
  const remembered = localStorage.getItem('nightjar_last_destination');
  if (localStorage.getItem('nightjar_onboarding_dismissed') === 'true' && remembered
    && ['/jobs', '/applications'].includes(remembered)) window.history.replaceState(null, '', remembered);
}
