import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useSync } from '@/providers/SyncProvider';
import { useWatchlist, toggleWatch } from '@/hooks/useWatchlist';
import { Glyph } from '@/components/Icon';
import { Panel } from '@/motion/Panel';
import { tilt, useGlide, useTweenedNumber } from '@/motion/motion';
import { setFeed } from '@/views/Feed/feed-store';
import { relativeDue, dueDate } from '@/views/Pipeline/stages';

interface HomeJob { id: string; company: string; slug: string; title: string; seen: string; closed: string | null;
  status: string | null; next: string | null; due: string | null }

export function HomeView(): React.ReactNode {
  const { db } = useDatabase();
  const { lastSyncedAt } = useSync();
  const navigate = useNavigate();
  const watched = useWatchlist();
  const [jobs, setJobs] = useState<HomeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [leaving, setLeaving] = useState<string | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updates = useGlide();
  const watchGlide = useGlide();
  useEffect(() => () => { if (leaveTimer.current) clearTimeout(leaveTimer.current); }, []);
  useEffect(() => {
    let cancelled = false;
    void db.query<{ id: string; data: string; first_seen_at: string; closed_at: string | null; status: string | null;
      next_action: string | null; next_action_at: string | null; deadline: string | null }>(
      `SELECT p.id,p.data,p.first_seen_at,p.closed_at,a.status,a.next_action,a.next_action_at,a.deadline
       FROM postings_cache p LEFT JOIN applications a ON p.id=a.posting_id ORDER BY p.first_seen_at DESC`)
      .then(rows => {
        if (cancelled) return;
        setJobs(rows.flatMap(row => {
          try { const data = JSON.parse(row.data) as Record<string, string>;
            return [{ id: row.id, company: data.company ?? '', slug: data.company_slug ?? '', title: data.title ?? '',
              seen: row.first_seen_at, closed: row.closed_at, status: row.status,
              next: row.next_action, due: row.next_action_at || row.deadline }];
          } catch { return []; }
        })); setLoading(false);
      }).catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [db, lastSyncedAt]);

  const companies = useMemo(() => {
    const map = new Map<string, { name: string; slug: string; count: number }>();
    for (const job of jobs) {
      if (!job.slug || job.closed) continue;
      const entry = map.get(job.slug) ?? { name: job.company, slug: job.slug, count: 0 };
      entry.count++; map.set(job.slug, entry);
    }
    return map;
  }, [jobs]);
  const attention = jobs.filter(job => job.due && job.status && !['rejected', 'ghosted', 'skipped', 'new'].includes(job.status))
    .filter(job => dueDate(job.due!).getTime() < Date.now() + 8 * 86400000)
    .sort((a, b) => a.due!.localeCompare(b.due!)).slice(0, 3);
  const fresh = watched.map(company => ({ ...company, count: jobs.filter(job => job.slug === company.slug
    && !job.closed && job.seen > company.since).length })).filter(company => company.count > 0);
  const saved = jobs.filter(job => job.status === 'saved').length;
  const openCount = jobs.filter(job => !job.closed && job.status !== 'skipped' && !job.id.startsWith('local-')).length;
  const shownOpen = useTweenedNumber(loading ? 0 : openCount, 1100, 0);
  const suggestions = [...companies.values()]
    .filter(c => !watched.some(w => w.slug === c.slug) && c.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => query ? a.name.localeCompare(b.name) : b.count - a.count).slice(0, query ? 6 : 3);
  const alertsOn = localStorage.getItem('nightjar_watch_alerts') === 'true';
  const goCompany = (slug: string): void => { setFeed({ companyFilter: slug, search: '' }); navigate('/jobs'); };
  const unwatch = (slug: string, name: string): void => {
    watchGlide.hide();
    setLeaving(slug);
    leaveTimer.current = setTimeout(() => { toggleWatch(slug, name); setLeaving(null); }, 340);
  };
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return <div className="page page-enter">
    <div className="home">
      <Panel className="home-main" aria-label="Home">
        <div className="home-scroll scroll">
          <div className="home-top">
            <h1 className="h1">{today}</h1>
            <span>{updatedLabel(lastSyncedAt)}</span>
          </div>
          {error && <p role="alert" className="kicker">Couldn’t load your workspace. Reopen this page to try again.</p>}

          <section aria-label="Needs attention" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 className="kicker">Needs attention this week</h2>
            {loading ? <div className="cards3">{[0, 1, 2].map(i => <div key={i} className="card" style={{ height: 132 }}><span className="sk" style={{ width: '40%' }} /><span className="sk" style={{ width: '80%', height: 14 }} /><span className="sk" style={{ width: '50%' }} /></div>)}</div>
              : attention.length ? <div className="cards3">{attention.map((job, i) => {
                const rel = relativeDue(job.due!);
                return <Link key={job.id} className="card tilt" to={`/applications?job=${encodeURIComponent(job.id)}`}
                  onMouseMove={tilt.onMouseMove} onMouseLeave={tilt.onMouseLeave}
                  style={{ animation: 'rowIn 600ms var(--out) backwards', animationDelay: `${String(i * 40)}ms` }}>
                  <span className={`card-when ${rel.hot ? 'hot' : ''}`}>{rel.label}</span>
                  <span className="card-next">{job.next || 'Application deadline'}</span>
                  <span className="card-co"><span className="mark sm" aria-hidden="true">{initial(job.company)}</span><span>{job.company}</span></span>
                </Link>;
              })}</div>
              : <div className="quiet" style={{ animation: 'rowIn 600ms var(--out) backwards' }}>
                <div><strong>You have room to explore.</strong><p>Nothing due in your tracker this week.</p></div>
                <Link className="link" to="/jobs"><span className="u">Browse jobs</span><Glyph name="go" size={14} /></Link>
              </div>}
          </section>

          <section aria-label="Since you last looked" onMouseMove={updates.onMouseMove} onMouseLeave={updates.onMouseLeave}
            style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, perspective: 900 }}>
            <h2 className="kicker" style={{ marginBottom: 6 }}>Since you last looked</h2>
            <div ref={updates.glideRef} className="glide" aria-hidden="true" style={{ left: -16, right: -16 }} />
            {fresh.map((company, i) => <button key={company.slug} type="button" className="hrow" data-glide onClick={() => goCompany(company.slug)}
              style={{ border: 0, background: 'transparent', textAlign: 'left', animation: 'rowIn 600ms var(--out) backwards', animationDelay: `${String(120 + i * 40)}ms` }}>
              <span className="mark lg" aria-hidden="true">{initial(company.name)}</span>
              <span className="hrow-text"><span>{company.count} new {company.count === 1 ? 'role' : 'roles'} at {company.name}</span><span>Watching</span></span>
              <Glyph name="go" className="go" />
            </button>)}
            {saved > 0 && <Link className="hrow" data-glide to="/applications?view=saved"
              style={{ animation: 'rowIn 600ms var(--out) backwards', animationDelay: `${String(120 + fresh.length * 40)}ms` }}>
              <span className="mark lg" aria-hidden="true"><Glyph name="bookmark" width={1.5} /></span>
              <span className="hrow-text"><span>{saved} saved {saved === 1 ? 'role' : 'roles'} to come back to</span><span>Pick up where you left off</span></span>
              <Glyph name="go" className="go" />
            </Link>}
            <Link className="hrow" data-glide to="/jobs" onClick={() => setFeed({ companyFilter: null })}
              style={{ animation: 'rowIn 600ms var(--out) backwards', animationDelay: `${String(120 + (fresh.length + (saved ? 1 : 0)) * 40)}ms` }}>
              <span className="mark lg" aria-hidden="true"><Glyph name="lines" width={1.5} /></span>
              <span className="hrow-text"><span className="tnum">{shownOpen.toLocaleString('en-US')} open roles</span><span>Browse, or narrow to your field</span></span>
              <Glyph name="go" className="go" />
            </Link>
          </section>
        </div>
      </Panel>

      <Panel as="aside" className="watch" aria-label="Watching">
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 1 }}>
          <h2 className="h2">Watching</h2>
          <button type="button" className="icb" onClick={() => { setAdding(!adding); setQuery(''); }} aria-label={adding ? 'Close company search' : 'Watch a company'} aria-expanded={adding}
            style={{ width: 36, height: 36, color: 'rgba(var(--fg-rgb),.8)' }}>
            <Glyph name="plus" size={13} width={1.7} style={{ transform: adding ? 'rotate(45deg)' : 'none', transition: 'transform 300ms cubic-bezier(.2,.8,.2,1)' }} />
          </button>
        </div>
        {adding && <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: 6, animation: 'rowIn 360ms cubic-bezier(.2,.8,.2,1) both' }}>
          <input className="fld sm" autoFocus aria-label="Find a company to watch" placeholder="Find a company" value={query}
            onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setAdding(false); }} />
          {suggestions.map(company => <button key={company.slug} type="button" className="sug" onClick={() => { toggleWatch(company.slug, company.name); setAdding(false); setQuery(''); }}>
            <span>{company.name}</span><span>{company.count} open</span>
          </button>)}
          {companies.size === 0 && <p className="dsc" style={{ margin: '4px 12px' }}>Companies appear once jobs have loaded.</p>}
          {companies.size > 0 && suggestions.length === 0 && <p className="dsc" style={{ margin: '4px 12px' }}>No company by that name.</p>}
        </div>}
        <div className="watch-list scroll" onMouseMove={e => { if (!leaving) watchGlide.onMouseMove(e); }} onMouseLeave={watchGlide.onMouseLeave}>
          <div ref={watchGlide.glideRef} className="glide" aria-hidden="true" style={{ borderRadius: 14 }} />
          {watched.length === 0 && !adding && <p className="dsc" style={{ margin: '4px 0' }}>Keep the companies you care about close. Their new roles show up here.</p>}
          {watched.map((company, i) => <div key={company.slug} className="wrow" data-glide
            style={{ animation: leaving === company.slug ? 'wFold 340ms var(--out) forwards' : 'rowIn 600ms var(--out) backwards', animationDelay: leaving === company.slug ? '0ms' : `${String(160 + i * 40)}ms` }}>
            <span className="mark md" aria-hidden="true">{initial(company.name)}</span>
            <button type="button" className="wrow-name" onClick={() => goCompany(company.slug)} style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left' }}>
              <span>{company.name}</span><span>{companies.get(company.slug)?.count ?? 0} open roles</span>
            </button>
            <button type="button" className="icb x" aria-label={`Stop watching ${company.name}`} onClick={() => unwatch(company.slug, company.name)}>
              <Glyph name="close" size={11} width={1.8} />
            </button>
          </div>)}
        </div>
        {watched.length > 0 && <Link className="alert link" to="/settings#alerts" style={{ position: 'relative', zIndex: 1 }}>
          <span style={{ fontSize: 15, lineHeight: 1.45, color: 'var(--fg)', fontWeight: 400 }}>{alertsOn
            ? `Alerts are on for ${String(watched.length)} ${watched.length === 1 ? 'company' : 'companies'}. New roles also land here.`
            : 'Get a heads-up when a company you watch posts a new role.'}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 500, color: 'var(--fg)' }}>
            <span className="u">{alertsOn ? 'Manage alerts' : 'Set up alerts'}</span><Glyph name="go" size={13} />
          </span>
        </Link>}
      </Panel>
    </div>
  </div>;
}

function initial(name: string): string {
  return (name.trim().charAt(0) || '·').toUpperCase();
}

function updatedLabel(iso: string | null): string {
  if (!iso) return 'Checking for jobs…';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'Jobs updated just now';
  if (minutes < 60) return `Jobs updated ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Jobs updated ${String(hours)} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `Jobs updated ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
