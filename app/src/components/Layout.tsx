import { useEffect, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useSync } from '@/providers/SyncProvider';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { applyAppearance, useAppearance } from '@/hooks/useAppearance';
import { isTauri } from '@/lib/platform';
import { Brand, Icon } from './Icon';

export function Layout({ children }: { children: ReactNode }): ReactNode {
  const { status } = useSync();
  const { online } = useNetworkStatus();
  const theme = useAppearance();
  const location = useLocation();
  useEffect(() => {
    applyAppearance();
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', applyAppearance);
    return () => media?.removeEventListener('change', applyAppearance);
  }, [theme]);
  useEffect(() => {
    if (['/', '/jobs', '/applications'].includes(location.pathname)) {
      localStorage.setItem('nightjar_last_destination', location.pathname);
    }
  }, [location.pathname]);
  return <div className={`app-shell ${isTauri() ? 'desktop-shell' : 'browser-shell'}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="app-navigation">
      <NavLink to="/" aria-label="Nightjar home" className="brand-link"><Brand /></NavLink>
      <nav className="main-tabs" aria-label="Main navigation">
        {([{ to: '/', name: 'Home', icon: 'home' }, { to: '/jobs', name: 'Jobs', icon: 'jobs' },
          { to: '/applications', name: 'Tracker', icon: 'tracker' }] as const).map(tab =>
          <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => `nav-tab ${isActive ? 'active' : ''}`}>
            <Icon name={tab.icon} /><span>{tab.name}</span>
          </NavLink>)}
      </nav>
      <div className="nav-utility"><span className="local-label">Your private workspace</span>
        <NavLink to="/settings" aria-label="Settings" className={({ isActive }) => `icon-button ${isActive ? 'active' : ''}`}><Icon name="settings" /></NavLink>
      </div>
    </header>
    <main id="main-content" tabIndex={-1} className="app-main">
      {!online ? <div className="connection-notice" role="alert" data-testid="offline-banner">You're offline. Your saved information is still available.</div>
        : status === 'error' ? <div className="connection-notice" role="status">Couldn't check for new jobs. Your saved information is still available.</div> : null}
      {children}
    </main>
  </div>;
}
