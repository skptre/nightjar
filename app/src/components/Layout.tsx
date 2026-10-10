import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useSync } from '@/providers/SyncProvider';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { applyAppearance, useAppearance } from '@/hooks/useAppearance';
import { getFeedFreshness } from '@/sync/feed-sync';
import { useUpdater } from '@/updates/updater';
import { feedSnapshot, feedSubscribe, setFeed } from '@/views/Feed/feed-store';
import { SEARCH_INPUT_ID, focusHeaderSearch, setTrackerQuery, useTrackerQuery } from '@/lib/search';
import { Brand, Glyph } from './Icon';
import { useWorkspaceNotices } from './WorkspaceServices';
import { Startup, STARTUP_VARS, shouldPlayStartup } from './Startup';

const TABS = [{ to: '/', name: 'Home' }, { to: '/jobs', name: 'Jobs' }, { to: '/applications', name: 'Tracker' }] as const;

interface Notice { id: string; dot: string; text: string; role: 'alert' | 'status'; pulse?: boolean; action?: { label: string; to?: string; run?: () => void } }

export function Layout({ children }: { children: ReactNode }): ReactNode {
  const location = useLocation();
  const theme = useAppearance();
  const [booting, setBooting] = useState(() => shouldPlayStartup());
  const endBoot = useCallback(() => setBooting(false), []);
  useEffect(() => {
    applyAppearance();
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', applyAppearance);
    return () => media?.removeEventListener('change', applyAppearance);
  }, [theme]);
  // "/" focuses search from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null;
      const typing = el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); focusHeaderSearch(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const notices = useNotices(location.pathname);
  return <div className={`nj-app ${booting ? 'booting' : ''}`} style={booting ? STARTUP_VARS : undefined}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="nj-header">
      <Link to="/" aria-label="Nightjar home" style={{ textDecoration: 'none' }}><Brand /></Link>
      <NavCapsule pathname={location.pathname} />
      <div className="nj-end">
        <NavLink to="/settings" aria-label="Settings" className={({ isActive }) => `pbtn ${isActive ? 'active' : ''}`}><Glyph name="user" width={1.5} /></NavLink>
      </div>
    </header>
    {notices.length > 0 && <div className="notices">{notices.map(n =>
      <div key={n.id} className="notice" role={n.role}>
        <span className={`stdot ${n.pulse ? 'pulse' : ''}`} style={{ background: n.dot }} />
        <span>{n.text}</span>
        {n.action && (n.action.to
          ? <Link className="nact" to={n.action.to}>{n.action.label}</Link>
          : <button type="button" className="nact" onClick={n.action.run}>{n.action.label}</button>)}
      </div>)}</div>}
    <main id="main-content" tabIndex={-1} className="nj-stage" style={{ top: 86 + notices.length * 56, outline: 'none' }}>
      {children}
    </main>
    {booting && <Startup onDone={endBoot} />}
  </div>;
}

/** Calm, specific notices with a next step. Shown above the page, which slides down to make room. */
function useNotices(pathname: string): Notice[] {
  const { status, refreshJobs } = useSync();
  const { online } = useNetworkStatus();
  const update = useUpdater();
  const { saveError, backupError } = useWorkspaceNotices();
  const list: Notice[] = [];
  if (!online) list.push({ id: 'offline', dot: 'rgba(var(--fg-rgb),.4)', role: 'alert', text: 'You’re offline. Everything you saved is still here.' });
  else if (status === 'error') list.push({ id: 'sync', dot: 'var(--st-assess)', role: 'status', text: 'Couldn’t check for new jobs. Your saved information is fine.',
    action: { label: 'Try again', run: () => void refreshJobs?.() } });
  if (online && status !== 'error' && (pathname === '/' || pathname === '/jobs')) {
    const freshness = getFeedFreshness();
    const published = freshness.updatedAt ? new Date(freshness.updatedAt) : null;
    const valid = published && Number.isFinite(published.getTime());
    const stale = valid && Date.now() - published.getTime() > 48 * 60 * 60 * 1000;
    if (freshness.source === 'bundled' || stale) {
      const when = valid ? published.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
      list.push({ id: 'stale', dot: 'var(--st-assess)', role: 'status',
        text: freshness.source === 'bundled' ? 'Showing jobs included with this version. Newer ones may be missing.' : `Showing jobs published ${when ?? 'a while ago'}. Newer ones may be missing.`,
        action: { label: 'Check now', run: () => void refreshJobs?.() } });
    }
  }
  if (update.phase === 'available') list.push({ id: 'update', dot: 'var(--st-applied)', role: 'status', text: `Nightjar ${update.version ?? ''} is ready. You choose when to install.`,
    action: { label: 'Review', to: '/settings#updates' } });
  if (saveError) list.push({ id: 'save', dot: 'var(--danger)', role: 'alert', pulse: true, text: 'A change couldn’t be saved. Save a backup before you restart.',
    action: { label: 'Open backups', to: '/settings#workspace' } });
  if (backupError) list.push({ id: 'backup', dot: 'var(--danger)', role: 'alert', text: 'The automatic recovery copy couldn’t be saved. Your workspace is fine.',
    action: { label: 'Check backups', to: '/settings#workspace' } });
  return list;
}

/** Home / Jobs / Tracker with a pill that travels between tabs, plus the shared search box. */
function NavCapsule({ pathname }: { pathname: string }): ReactNode {
  const capRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const hovRef = useRef<HTMLSpanElement>(null);
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const prev = useRef<{ x: number; w: number } | null>(null);
  const pillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = TABS.findIndex(tab => tab.to === pathname);
  useLayoutEffect(() => {
    const a = active >= 0 ? linkRefs.current[active] : null;
    const from = prev.current;
    const to = a && a.offsetWidth ? { x: a.offsetLeft, w: a.offsetWidth } : null;
    prev.current = to;
    const p = pillRef.current, cap = capRef.current;
    if (!from || !to || !p || !cap || Math.abs(from.x - to.x) < 2) return;
    // Slide from the old tab, then hand back to the tab's own fill.
    p.style.transition = 'none';
    p.style.transform = `translateX(${String(from.x)}px)`;
    p.style.width = `${String(from.w)}px`;
    p.style.opacity = '1';
    cap.classList.add('sliding');
    void p.getBoundingClientRect();
    p.style.transition = 'transform 620ms var(--spring), width 620ms var(--spring)';
    p.style.transform = `translateX(${String(to.x)}px)`;
    p.style.width = `${String(to.w)}px`;
    if (pillTimer.current) clearTimeout(pillTimer.current);
    pillTimer.current = setTimeout(() => { cap.classList.remove('sliding'); p.style.opacity = '0'; }, 640);
  }, [active]);
  useEffect(() => () => { if (pillTimer.current) clearTimeout(pillTimer.current); }, []);
  const hoverTo = (el: HTMLElement): void => {
    const h = hovRef.current;
    if (!h) return;
    const shown = h.style.opacity === '1';
    h.style.transition = shown ? 'transform 460ms var(--spring), width 460ms var(--spring), opacity 200ms ease' : 'opacity 200ms ease';
    h.style.transform = `translateX(${String(el.offsetLeft)}px)`;
    h.style.width = `${String(el.offsetWidth)}px`;
    h.style.opacity = '1';
  };
  const hoverOut = (): void => { if (hovRef.current) hovRef.current.style.opacity = '0'; };
  return <nav ref={capRef} className="cap" aria-label="Main navigation" onMouseLeave={hoverOut}>
    <span ref={hovRef} className="nhov" aria-hidden="true" />
    <span ref={pillRef} className="npill" aria-hidden="true" />
    {TABS.map((tab, i) => <Link key={tab.to} to={tab.to} ref={el => { linkRefs.current[i] = el; }}
      className={i === active ? 'navon' : 'navlink'} aria-current={i === active ? 'page' : undefined}
      onMouseEnter={e => hoverTo(e.currentTarget)}>{tab.name}</Link>)}
    <span className="cap-div" />
    <HeaderSearch pathname={pathname} onEnter={hoverOut} />
  </nav>;
}

function HeaderSearch({ pathname, onEnter }: { pathname: string; onEnter: () => void }): ReactNode {
  const navigate = useNavigate();
  const feedSearch = useSyncExternalStore(feedSubscribe, () => feedSnapshot().search);
  const trackerQuery = useTrackerQuery();
  const tracker = pathname === '/applications';
  const value = tracker ? trackerQuery : feedSearch;
  const set = (next: string): void => {
    if (tracker) { setTrackerQuery(next); return; }
    setFeed({ search: next });
    if (pathname !== '/jobs' && next) navigate('/jobs');
  };
  return <label className="cap-search" onMouseEnter={onEnter}>
    <Glyph name="search" size={15} />
    <input id={SEARCH_INPUT_ID} className="srch" type="search" value={value} autoComplete="off" spellCheck={false}
      placeholder={tracker ? 'Search applications' : 'Search'} aria-label={tracker ? 'Search applications' : 'Search roles or companies'}
      onChange={e => set(e.target.value)}
      onKeyDown={e => { if (e.key === 'Escape') { set(''); e.currentTarget.blur(); } }} />
    {value && <button type="button" className="srch-clear" aria-label="Clear search" onClick={() => { set(''); focusHeaderSearch(); }}><Glyph name="close" size={9} width={2} /></button>}
  </label>;
}
