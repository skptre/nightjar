export function restoreDestination(): void {
  // Every ordinary launch opens on Home, after the launch animation. Deep links
  // (a path or a query, e.g. from a notification) are left alone.
  if (window.location.search || window.location.pathname === '/') return;
  if (['/jobs', '/applications', '/settings'].includes(window.location.pathname)) return;
  window.history.replaceState(null, '', '/');
}
