import { setDensity, useDensity, setTheme, useAppearance, type Theme, type Density } from '@/hooks/useAppearance';
import { Glyph } from '@/components/Icon';
import { requestNotificationPermission } from '@/sync/notifications';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useState, useEffect, useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useProfile } from '@/providers/ProfileProvider';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useToast } from '@/components/Toast';
import { isTauri, GMAIL_ENABLED } from '@/lib/platform';
import {
  WORK_AUTH_OPTIONS,
  DEGREE_TYPE_OPTIONS,
  type DegreeType,
  CATEGORY_GROUPS,
  computeGradWindow,
  inferRequiresSponsorship,
} from '@/profile/types';
import type { Profile } from '@/profile/types';
import { exportApplicationsCSV } from '@/export/export-csv';
import { exportApplicationsJSON } from '@/export/export-json';
import { exportPostingsJSON } from '@/export/export-postings';
import { saveFile } from '@/export/file-save';
import { recomputeAll } from '@/classify/recompute';
import type { GmailAuthState } from '@/integrations/types';
import { getAuthState, startOAuthFlow, disconnectGmail } from '@/integrations/gmail-auth';
import { clearAllGmailData } from '@/integrations/gmail-service';
import { clearAllLocalData } from '@/db/clear-local-data';
import { BackupSection } from '@/backup/BackupSection';
import { UpdateSection } from '@/updates/UpdateSection';
import { SupportSection } from '@/support/SupportSection';
import { APP_VERSION } from '@/updates/updater';
import { Panel } from '@/motion/Panel';
import { animateScroll, useScrollThumb } from '@/motion/motion';

const SECTIONS: { id: string; label: string; d: string }[] = [
  { id: 'profile', label: 'Profile', d: 'M8 8a2.75 2.75 0 1 0 0-5.5A2.75 2.75 0 0 0 8 8zM2.75 14c.8-2.6 2.9-4 5.25-4s4.45 1.4 5.25 4' },
  { id: 'appearance', label: 'Appearance', d: 'M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11zM8 2.5v11' },
  { id: 'alerts', label: 'Alerts', d: 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3' },
  { id: 'workspace', label: 'Workspace', d: 'M2.5 4.5h11v3h-11zM3.5 7.5v6h9v-6M6.5 10h3' },
  { id: 'updates', label: 'Updates', d: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3' },
  { id: 'support', label: 'Support', d: 'M8 13.5a5.5 5.5 0 1 0 0-11a5.5 5.5 0 0 0 0 11zM6.4 6.4a1.7 1.7 0 0 1 3.2.8c0 1.1-1.6 1.4-1.6 2.3M8 11.2v.1' },
  { id: 'data', label: 'Data', d: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2' },
  { id: 'general', label: 'General', d: 'M3 5h6M11 5h2M3 11h2M7 11h6M9 3.5v3M5 9.5v3' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function SettingsView(): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const railiRef = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(0);
  const lock = useRef(false);
  const thumb = useScrollThumb();
  const sections = SECTIONS.filter(s => s.id !== 'general' || isTauri());

  // The rail indicator follows the section you are reading.
  const placeRail = useCallback((n: number, instant = false): void => {
    const i = railiRef.current, b = railRef.current?.querySelectorAll<HTMLElement>('.rl')[n];
    if (!i || !b) return;
    i.style.transition = instant ? 'none' : 'transform 520ms var(--spring)';
    i.style.transform = `translateY(${String(b.offsetTop)}px)`;
  }, []);
  useLayoutEffect(() => placeRail(0, true), [placeRail]);
  const goTo = useCallback((n: number): void => {
    const c = scrollRef.current;
    const sec = c?.querySelector<HTMLElement>(`[data-sec="${sections[n]!.id}"]`);
    if (!c || !sec) return;
    lock.current = true;
    setActive(n); placeRail(n);
    animateScroll(c, Math.min(sec.offsetTop - 34, c.scrollHeight - c.clientHeight), 700, () => { lock.current = false; });
  }, [sections, placeRail]);
  // Deep links such as /settings#updates land on their section.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    const n = sections.findIndex(s => s.id === id);
    if (n > 0) requestAnimationFrame(() => goTo(n));
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    thumb.onScroll(e);
    if (lock.current) return;
    const c = e.currentTarget;
    let n = 0;
    c.querySelectorAll<HTMLElement>('[data-sec]').forEach((s, k) => { if (s.offsetTop - c.scrollTop <= 140) n = k; });
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 4) n = sections.length - 1;
    n = Math.min(n, sections.length - 1);
    if (n !== active) { setActive(n); placeRail(n); }
  };

  return <div className="page page-enter">
    <Panel className="settings" aria-label="Settings">
      <nav className="rail" aria-label="Settings sections">
        <h1 className="h1" style={{ fontSize: 30, margin: '0 0 4px 12px' }}>Settings</h1>
        <p className="dim" style={{ margin: '0 0 26px 12px', fontSize: 14 }}>Everything stays on this device.</p>
        <div ref={railRef} className="rail-list">
          <span ref={railiRef} className="raili" aria-hidden="true" />
          {sections.map((s, n) => <button key={s.id} type="button" className="rl" aria-current={n === active} onClick={() => goTo(n)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={s.d} /></svg>
            {s.label}
          </button>)}
        </div>
        <span className="rail-ver dim" style={{ marginTop: 'auto', paddingLeft: 12, fontSize: 13 }}>Nightjar {APP_VERSION}</span>
      </nav>
      <div style={{ position: 'relative', flexGrow: 1, minWidth: 0, zIndex: 1 }}>
        <div ref={scrollRef} className="set-scroll scroll fade-settings" onScroll={onScroll}>
          <div className="set-col">
            <ProfileSection />
            <AppearanceSection />
            <AlertsSection />
            <BackupSection />
            <UpdateSection />
            <SupportSection />
            {GMAIL_ENABLED && isTauri() && <GmailSection />}
            <DataSection />
            {isTauri() && <GeneralSection />}
          </div>
        </div>
        <div className="thumb-track" aria-hidden="true"><div ref={thumb.thumbRef} className="thumb" /></div>
      </div>
    </Panel>
  </div>;
}

/** A brief "Saved" that fades in and out after each change. */
function useSavedPulse(): [ReactNode, () => void] {
  const [n, setN] = useState(0);
  return [<span key={n} className="saved" style={{ animation: n ? `saved${n % 2 ? 'A' : 'B'} 1800ms ease both` : 'none' }}>
    <Glyph name="check" size={12} width={1.8} />Saved
  </span>, () => setN(v => v + 1)];
}

/* ── Profile ─────────────────────────────────────────── */

function ProfileSection(): ReactNode {
  const { profile, updateProfile, beginProfileSetup, deleteProfile } = useProfile();
  const { db } = useDatabase();
  const [pulse, savedPulse] = useSavedPulse();
  const [gradOpen, setGradOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  if (!profile) {
    return <section data-sec="profile" id="profile">
      <h2 className="h2">Your preferences</h2>
      <p className="dsc" style={{ marginBottom: 18 }}>Tell Nightjar a little about you and For you ranks roles to fit.</p>
      <div className="srow">
        <div><div className="lbl">Personalize your jobs</div><div className="dsc">Graduation, work authorization, fields and locations. All optional, all on this device.</div></div>
        <button type="button" className="solid sm" onClick={beginProfileSetup}>Personalize</button>
      </div>
    </section>;
  }
  const save = (patch: Partial<Profile>, recompute = false): void => {
    updateProfile(patch);
    if (recompute) void recomputeAll(db, { ...profile, ...patch });
    savedPulse();
  };
  const [yearStr, monthStr] = (profile.graduation || `${String(new Date().getFullYear() + 1)}-05`).split('-');
  const year = Number(yearStr), month = Number(monthStr) - 1;
  const setGrad = (y: number, m: number): void => {
    const graduation = `${String(y)}-${String(m + 1).padStart(2, '0')}`;
    save({ graduation, grad_window: computeGradWindow(graduation) }, true);
  };
  const auth = WORK_AUTH_OPTIONS.find(o => o.value === profile.work_auth);
  const sponsorKnown = auth ? auth.requiresSponsorship : null;
  const thisYear = new Date().getFullYear();
  const locations = profile.locations ?? [];
  return <section data-sec="profile" id="profile">
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
      <div><h2 className="h2">Your preferences</h2><p className="dsc">Jobs are ranked with these. Changes apply right away.</p></div>
      {pulse}
    </div>
    <div className="srow">
      <div><div className="lbl">Graduating</div><div className="dsc">Used to match roles to your timeline.</div></div>
      <button type="button" className="ghost sm" aria-expanded={gradOpen} onClick={() => setGradOpen(!gradOpen)}>
        {profile.graduation ? `${MONTHS_LONG[month] ?? ''} ${String(year)}` : 'Not set'}
        <Glyph name="down" size={12} width={1.7} style={{ transform: gradOpen ? 'rotate(180deg)' : 'none', transition: 'transform 360ms var(--spring)' }} />
      </button>
    </div>
    <div className="exp" style={{ gridTemplateRows: gradOpen ? '1fr' : '0fr' }}><div>
      <div style={{ padding: '4px 0 22px', display: 'flex', flexDirection: 'column', gap: 14 }} {...(!gradOpen ? { inert: true } : {})}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="ghost sm" style={{ width: 38, padding: 0 }} aria-label="Earlier year" disabled={year <= thisYear - 1} onClick={() => setGrad(year - 1, month)}>‹</button>
          <span className="tnum" style={{ minWidth: 64, textAlign: 'center', fontSize: 16, fontWeight: 600 }}>{year}</span>
          <button type="button" className="ghost sm" style={{ width: 38, padding: 0 }} aria-label="Later year" disabled={year >= thisYear + 7} onClick={() => setGrad(year + 1, month)}>›</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 8 }}>
          {MONTHS.map((label, k) => <button key={label} type="button" className="chip sm" style={{ padding: 0 }} aria-pressed={k === month} onClick={() => setGrad(year, k)}>{label}</button>)}
        </div>
      </div>
    </div></div>
    <div className="srow">
      <div><div className="lbl">Degree</div><div className="dsc">The degree you’re working toward.</div></div>
      <div className="seg">{DEGREE_TYPE_OPTIONS.map(o => <button key={o.value} type="button" aria-pressed={profile.degree_type === o.value}
        onClick={() => save({ degree_type: o.value as DegreeType }, true)}>{o.label}</button>)}</div>
    </div>
    <div className="srow stack">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
        <div className="lbl">Work authorization</div>
        <span className="dim" style={{ fontSize: 14 }}>{profile.requires_sponsorship ? 'Needs sponsorship' : 'No sponsorship needed'}</span>
      </div>
      <div className="chips" style={{ marginTop: 14 }}>{WORK_AUTH_OPTIONS.map(o => <button key={o.value} type="button" className="chip sm" aria-pressed={profile.work_auth === o.value}
        onClick={() => { const s = inferRequiresSponsorship(o.value); save({ work_auth: o.value, requires_sponsorship: s ?? profile.requires_sponsorship }, true); }}>{o.label}</button>)}</div>
      <div className="exp" style={{ gridTemplateRows: sponsorKnown === null ? '1fr' : '0fr' }}><div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingTop: 16 }} {...(sponsorKnown !== null ? { inert: true } : {})}>
          <span className="dsc" style={{ margin: 0 }}>Will you need visa sponsorship?</span>
          <div className="seg">{([[true, 'Yes'], [false, 'No']] as const).map(([v, label]) => <button key={label} type="button" aria-pressed={profile.requires_sponsorship === v}
            onClick={() => save({ requires_sponsorship: v }, true)}>{label}</button>)}</div>
        </div>
      </div></div>
    </div>
    <div className="srow stack">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
        <div className="lbl">Fields you’re interested in</div>
        <span className="dim tnum" style={{ fontSize: 14 }}>{profile.target_categories.length} selected</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>{CATEGORY_GROUPS.map(group => <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="chip-group-label">{group.label}</span>
        <div className="chips">{group.options.map(o => {
          const on = profile.target_categories.includes(o.value);
          return <button key={o.value} type="button" className="chip sm" aria-pressed={on} onClick={() => save({ target_categories: on
            ? profile.target_categories.filter(c => c !== o.value) : [...profile.target_categories, o.value] }, true)}>{o.shortLabel}</button>;
        })}</div>
      </div>)}</div>
    </div>
    <div className="srow stack">
      <div className="lbl">Locations</div>
      <div className="dsc">A city, a state or Remote. Press Enter to add.</div>
      <div className="chips" style={{ marginTop: 14, alignItems: 'center' }}>
        {locations.map(loc => <span key={loc} className="loc-chip fadein">{loc}
          <button type="button" className="locx" aria-label={`Remove ${loc}`} onClick={() => save({ locations: locations.filter(l => l !== loc) })}><Glyph name="close" size={9} width={2} /></button>
        </span>)}
        <input className="loc-input" aria-label="Add a location" placeholder="Add a location" onKeyDown={e => {
          if (e.key !== 'Enter') return;
          const v = e.currentTarget.value.trim();
          if (v && !locations.includes(v)) save({ locations: [...locations, v] });
          e.currentTarget.value = '';
        }} />
      </div>
    </div>
    <div className="srow">
      <div><div className="lbl">Start over</div><div className="dsc">Clear these preferences. Your tracker and notes stay.</div></div>
      {resetting ? <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="ghost sm danger-line" onClick={() => { deleteProfile(); setResetting(false); }}>Clear preferences</button>
        <button type="button" className="ghost sm" onClick={() => setResetting(false)}>Cancel</button>
      </div> : <button type="button" className="ghost sm" onClick={() => setResetting(true)}>Clear…</button>}
    </div>
  </section>;
}

/* ── Appearance ──────────────────────────────────────── */

const SWATCH = {
  dark: { bg: '#000', line: 'rgba(255,255,255,.28)', ink: '#fff', soft: 'rgba(255,255,255,.3)' },
  light: { bg: '#f4f4f2', line: 'rgba(0,0,0,.2)', ink: '#0b0b0b', soft: 'rgba(0,0,0,.22)' },
};

function AppearanceSection(): ReactNode {
  const theme = useAppearance();
  const density = useDensity();
  const [pulse, savedPulse] = useSavedPulse();
  return <section data-sec="appearance" id="appearance">
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
      <div><h2 className="h2">Appearance</h2><p className="dsc">Pick a look. It changes as you click.</p></div>
      {pulse}
    </div>
    <div className="srow stack">
      <div className="lbl" style={{ marginBottom: 14 }}>Theme</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }} role="group" aria-label="Theme">
        {([['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']] as [Theme, string][]).map(([value, label]) => {
          const a = SWATCH[value === 'system' ? 'dark' : value], b = SWATCH[value === 'system' ? 'light' : value];
          const on = theme === value;
          return <button key={value} type="button" className="theme" aria-pressed={on} onClick={() => { setTheme(value); savedPulse(); }}>
            <div className="mini" style={{ background: b.bg }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: value === 'system' ? '50%' : '100%', background: a.bg }} />
              <div style={{ position: 'absolute', left: 12, right: 12, top: 12, height: 10, borderRadius: 999, border: `1px solid ${a.line}` }} />
              <div style={{ position: 'absolute', left: 12, right: 12, top: 30, bottom: -8, borderRadius: 9, border: `1px solid ${a.line}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
                <span style={{ width: '46%', height: 6, borderRadius: 99, background: a.ink }} />
                <span style={{ width: '70%', height: 4, borderRadius: 99, background: a.soft }} />
                <span style={{ width: '58%', height: 4, borderRadius: 99, background: a.soft }} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, padding: '0 4px' }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{label}</span>
              <span style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid rgba(var(--fg-rgb),.3)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: on ? 'var(--fg)' : 'transparent', transition: 'background-color 240ms ease', color: 'var(--bg)' }}>
                <Glyph name="check" size={10} width={2.2} style={{ opacity: on ? 1 : 0, transition: 'opacity 200ms ease' }} />
              </span>
            </div>
          </button>;
        })}
      </div>
    </div>
    <div className="srow stack">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
        <div><div className="lbl">Row spacing</div><div className="dsc">How much room rows get in Jobs and Tracker.</div></div>
        <div className="seg" aria-label="Row density">{([['comfortable', 'Comfortable'], ['compact', 'Compact']] as [Density, string][]).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={density === value} onClick={() => { setDensity(value); savedPulse(); }}>{label}</button>)}</div>
      </div>
      <div style={{ marginTop: 16, borderRadius: 16, border: '1px solid rgba(var(--fg-rgb),.1)', padding: '6px 16px' }} aria-hidden="true">
        {[['F', 'Software Engineer Intern', 'Figma', '$52/hr'], ['L', 'Software Engineer Intern, Fullstack', 'Lyft', '$50/hr'], ['N', 'Physical Design Intern', 'NVIDIA', '$45/hr']].map(([mark, title, company, pay], k) =>
          <div key={company} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: `${density === 'compact' ? '7px' : '13px'} 0`, borderTop: k ? '1px solid rgba(var(--fg-rgb),.07)' : 0, transition: 'padding 420ms var(--spring)' }}>
            <span className="mark" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 13 }}>{mark}</span>
            <span style={{ fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
            <span className="dim" style={{ fontSize: 15 }}>{company}</span>
            <span style={{ marginLeft: 'auto', fontSize: 14, color: 'rgba(var(--fg-rgb),.6)' }}>{pay}</span>
          </div>)}
      </div>
    </div>
  </section>;
}

/* ── Alerts ──────────────────────────────────────────── */

function AlertsSection(): ReactNode {
  const watched = useWatchlist();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(() => localStorage.getItem('nightjar_watch_alerts') === 'true');
  const [busy, setBusy] = useState(false);
  const toggle = (): void => {
    if (enabled) { localStorage.setItem('nightjar_watch_alerts', 'false'); setEnabled(false); toast('Alerts are off'); return; }
    setBusy(true);
    void requestNotificationPermission().then(permission => {
      if (permission === 'granted') {
        localStorage.setItem('nightjar_watch_alerts', 'true'); setEnabled(true);
        toast(`Alerts are on for ${String(watched.length)} ${watched.length === 1 ? 'company' : 'companies'}`);
      } else toast('Notifications are blocked. Allow them in your system settings.', 'info');
    }).catch(() => toast('Notifications are unavailable here. Updates still appear on Home.', 'info')).finally(() => setBusy(false));
  };
  return <section data-sec="alerts" id="alerts">
    <h2 className="h2">Alerts</h2>
    <p className="dsc" style={{ marginBottom: 18 }}>A quiet heads-up, never a stream of pings.</p>
    <div className="srow">
      <div>
        <div className="lbl">New roles at companies you watch</div>
        <div className="dsc">One bundled notification while Nightjar runs in the background. Updates also stay on Home.</div>
        <Link className="link" to="/" style={{ marginTop: 10, fontSize: 13, color: 'rgba(var(--fg-rgb),.7)' }}>
          <span className="u">{watched.length ? `Watching ${String(watched.length)} ${watched.length === 1 ? 'company' : 'companies'}` : 'Watch a company on Home'}</span><Glyph name="go" size={12} />
        </Link>
      </div>
      <button type="button" className="sw" role="switch" aria-checked={enabled} aria-label="Alerts for watched companies"
        disabled={busy || (!enabled && watched.length === 0)} onClick={toggle}><span className="k" /></button>
    </div>
  </section>;
}

/* ── General (desktop) ───────────────────────────────── */

function GeneralSection(): ReactNode {
  const { toast } = useToast();
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { isEnabled } = await import('@tauri-apps/plugin-autostart');
        const value = await isEnabled();
        if (!cancelled) { setAutoLaunch(value); setLoading(false); }
      } catch {
        if (!cancelled) { setLoading(false); toast('Could not read the startup setting. Try changing it again.', 'error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [toast]);
  const toggle = async (): Promise<void> => {
    setLoading(true);
    try {
      const plugin = await import('@tauri-apps/plugin-autostart');
      if (autoLaunch) { await plugin.disable(); setAutoLaunch(false); } else { await plugin.enable(); setAutoLaunch(true); }
    } catch { toast('Could not change launch on startup. Your previous setting is unchanged.', 'error'); }
    finally { setLoading(false); }
  };
  return <section data-sec="general" id="general">
    <h2 className="h2">General</h2>
    <p className="dsc" style={{ marginBottom: 18 }}>How the desktop app behaves.</p>
    <div className="srow">
      <div><div className="lbl">Open when you sign in</div><div className="dsc">Starts minimized so job checks and alerts keep running.</div></div>
      <button type="button" className="sw" role="switch" aria-checked={autoLaunch} aria-label="Open when you sign in" disabled={loading} onClick={() => void toggle()}><span className="k" /></button>
    </div>
    <div className="srow">
      <div><div className="lbl">Closing the window</div><div className="dsc">Closing quits Nightjar. Minimize it instead to keep checking for jobs in the background.</div></div>
    </div>
  </section>;
}

/* ── Data ────────────────────────────────────────────── */

function DataSection(): ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [exporting, setExporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const handleExport = useCallback(async (type: 'csv' | 'json' | 'postings') => {
    setExporting(true);
    try {
      const day = new Date().toISOString().slice(0, 10);
      const csv = [{ name: 'CSV', extensions: ['csv'] }], json = [{ name: 'JSON', extensions: ['json'] }];
      const [content, defaultName, filters] = type === 'csv'
        ? [await exportApplicationsCSV(db), `nightjar-applications-${day}.csv`, csv]
        : type === 'json'
          ? [await exportApplicationsJSON(db), `nightjar-applications-${day}.json`, json]
          : [await exportPostingsJSON(db), `nightjar-postings-backup-${day}.json`, json];
      const result = await saveFile({ content, defaultName, filters });
      if (result) toast(`Exported ${defaultName}`);
    } catch (err: unknown) {
      toast(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    } finally { setExporting(false); }
  }, [db, toast]);
  const handleClearData = useCallback(async () => {
    setClearing(true);
    try { await clearAllLocalData(db); window.location.reload(); }
    catch (err: unknown) { toast(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error'); setClearing(false); }
  }, [db, toast]);
  return <section data-sec="data" id="data">
    <h2 className="h2">Your data</h2>
    <p className="dsc" style={{ marginBottom: 18 }}>Take it with you any time.</p>
    <div className="srow">
      <div><div className="lbl">Export applications</div><div className="dsc">Your tracker as a spreadsheet or JSON.</div></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="ghost sm" disabled={exporting} onClick={() => void handleExport('csv')}>CSV</button>
        <button type="button" className="ghost sm" disabled={exporting} onClick={() => void handleExport('json')}>JSON</button>
      </div>
    </div>
    <div className="srow">
      <div><div className="lbl">Export job listings</div><div className="dsc">Every posting saved on this device.</div></div>
      <button type="button" className="ghost sm" disabled={exporting} onClick={() => void handleExport('postings')}>JSON</button>
    </div>
    <div className="srow">
      <div><div className="lbl">Where it lives</div><div className="dsc">{isTauri() ? 'A single database file in the app data folder.' : 'In this browser. Export a copy before clearing browser data.'}</div></div>
      {isTauri() && <code className="code">nightjar.db</code>}
    </div>
    <div className="danger-box">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
        <div><div className="lbl">Delete everything on this device</div><div className="dsc">Profile, tracker, notes, saved jobs and recovery copies. Files you exported are kept.</div></div>
        <button type="button" className="ghost sm danger-line" onClick={() => { setDeleting(!deleting); setConfirmText(''); }}>{deleting ? 'Cancel' : 'Delete…'}</button>
      </div>
      <div className="exp" style={{ gridTemplateRows: deleting ? '1fr' : '0fr' }}><div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 16 }} {...(!deleting ? { inert: true } : {})}>
          <input className="danger-input" aria-label="Type delete to confirm" placeholder="Type “delete” to confirm" value={confirmText} onChange={e => setConfirmText(e.target.value)} />
          <button type="button" className="danger" disabled={confirmText.trim().toLowerCase() !== 'delete' || clearing} onClick={() => void handleClearData()}>{clearing ? 'Deleting…' : 'Delete everything'}</button>
        </div>
      </div></div>
    </div>
  </section>;
}

/* ── Gmail (behind GMAIL_ENABLED) ────────────────────── */

function GmailSection(): ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const [authState, setAuthState] = useState<GmailAuthState>({ connected: false, email: null, lastScanAt: null, error: null });
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [clientId, setClientId] = useState(() => localStorage.getItem('nightjar_gmail_client_id') ?? '');
  useEffect(() => {
    let cancelled = false;
    void getAuthState().then((state) => { if (!cancelled) { setAuthState(state); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);
  const connect = async (): Promise<void> => {
    if (!clientId.trim()) { toast('Set a Gmail client ID first', 'error'); return; }
    setLoading(true);
    try { await startOAuthFlow(); toast('Finish signing in in your browser'); }
    catch (err: unknown) { toast(err instanceof Error ? err.message : 'Failed to start sign-in', 'error'); }
    finally { setLoading(false); }
  };
  const disconnect = async (): Promise<void> => {
    setLoading(true);
    try {
      await disconnectGmail(); await clearAllGmailData(db);
      setAuthState({ connected: false, email: null, lastScanAt: null, error: null }); setConfirm(false);
      toast('Gmail disconnected. Email data deleted.');
    } catch (err: unknown) { toast(err instanceof Error ? err.message : 'Failed to disconnect', 'error'); }
    finally { setLoading(false); }
  };
  return <section data-sec="gmail" id="gmail">
    <h2 className="h2">Gmail</h2>
    <p className="dsc" style={{ marginBottom: 18 }}>Scan your inbox for interviews, offers and rejections from companies you applied to. Email content never leaves this computer.</p>
    <div className="srow">
      <div><div className="lbl">{authState.connected ? `Connected${authState.email ? ` as ${authState.email}` : ''}` : 'Not connected'}</div>
        <div className="dsc">{authState.lastScanAt ? `Last scan ${new Date(authState.lastScanAt).toLocaleString()}` : 'Read-only access. Nightjar never sends email.'}</div></div>
      {authState.connected
        ? confirm ? <div style={{ display: 'flex', gap: 8 }}><button type="button" className="ghost sm danger-line" disabled={loading} onClick={() => void disconnect()}>Disconnect and delete</button><button type="button" className="ghost sm" onClick={() => setConfirm(false)}>Cancel</button></div>
          : <button type="button" className="ghost sm" onClick={() => setConfirm(true)}>Disconnect…</button>
        : <button type="button" className="solid sm" disabled={loading} onClick={() => void connect()}>Connect Gmail</button>}
    </div>
    <div className="srow">
      <div style={{ flexGrow: 1 }}><div className="lbl">OAuth client ID</div><div className="dsc">From a Desktop OAuth client with the Gmail API enabled.</div></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="fld sm" style={{ width: 240 }} value={clientId} onChange={e => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" aria-label="Google OAuth client ID" />
        <button type="button" className="ghost sm" onClick={() => {
          if (clientId.trim()) localStorage.setItem('nightjar_gmail_client_id', clientId.trim()); else localStorage.removeItem('nightjar_gmail_client_id');
          toast('Client ID saved');
        }}>Save</button>
      </div>
    </div>
  </section>;
}
