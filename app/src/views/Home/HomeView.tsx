import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useSync } from '@/providers/SyncProvider';
import { useWatchlist, toggleWatch } from '@/hooks/useWatchlist';
import { Icon } from '@/components/Icon';

interface HomeJob { id: string; company: string; slug: string; title: string; seen: string; closed: string | null;
  status: string | null; next: string | null; due: string | null }
export function HomeView(): React.ReactNode {
  const { db } = useDatabase();
  const { lastSyncedAt } = useSync();
  const watched = useWatchlist();
  const [jobs, setJobs] = useState<HomeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [alertsDismissed, setAlertsDismissed] = useState(() => localStorage.getItem('nightjar_alert_setup_dismissed') === 'true');
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
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [jobs]);
  const upcoming = jobs.filter(job => job.due && job.status && !['rejected', 'ghosted', 'skipped', 'new'].includes(job.status))
    .filter(job => new Date(job.due!).getTime() < Date.now() + 7 * 86400000)
    .sort((a, b) => a.due!.localeCompare(b.due!)).slice(0, 5);
  const newWatched = watched.map(company => ({ ...company, count: jobs.filter(job => job.slug === company.slug
    && !job.closed && job.seen > company.since).length })).filter(company => company.count > 0);
  const saved = jobs.filter(job => job.status === 'saved');
  return <div className="home-page">
    <div className="page-heading"><p className="eyebrow">YOUR WORKSPACE</p><h1>A little clarity for what’s next<span className="accent-dot">.</span></h1>
      <p>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
    {error && <p role="alert" className="connection-notice">Couldn't load your workspace. Please reopen this page.</p>}
    <div className="home-layout"><div>
      <div className="section-label">Needs attention <small>{upcoming.length ? `${upcoming.length} upcoming` : 'This week'}</small></div>
      <section className="attention-panel">
        {loading ? <div className="skeleton-block" aria-label="Loading workspace" role="status" /> : upcoming.length ? upcoming.map(job =>
          <Link className="home-row" key={job.id} to={`/applications?job=${encodeURIComponent(job.id)}`}><Icon name="clock" />
            <div><strong>{job.next || 'Application deadline'}</strong><p>{job.company} · {job.title}</p><p>{new Date(`${job.due!.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p></div><Icon name="arrow" /></Link>)
          : <div className="quiet-state"><Icon name="check" size={26} /><h2>You have room to explore.</h2><p>No upcoming deadlines in your tracker.<br />Find a role that deserves a closer look.</p><Link to="/jobs" className="text-button mt-5">Explore opportunities <Icon name="arrow" size={16} /></Link></div>}
      </section>
      <div className="section-label">Your next opportunities <small>At a glance</small></div>
      {newWatched.map(company => <Link className="home-row" key={company.slug} to={`/jobs?company=${encodeURIComponent(company.slug)}`}>
        <span className="company-monogram">{company.name.slice(0, 2).toUpperCase()}</span><div><strong>{company.count} new {company.count === 1 ? 'role' : 'roles'} at {company.name}</strong><p>Since you started watching</p></div><Icon name="arrow" /></Link>)}
      {saved.length > 0 && <Link className="home-row" to="/applications?view=saved"><Icon name="bookmark" /><div><strong>{saved.length} saved {saved.length === 1 ? 'role' : 'roles'} to come back to</strong><p>Pick up where you left off</p></div><Icon name="arrow" /></Link>}
      <Link className="home-row" to="/jobs"><Icon name="jobs" /><div><strong>{jobs.filter(job => !job.closed && job.status !== 'skipped').length.toLocaleString()} open opportunities</strong><p>Browse roles, or narrow down to your field</p></div><Icon name="arrow" /></Link>
    </div><aside>
      <section className="watch-panel"><div className="section-label"><span className="flex items-center gap-2"><Icon name="watch" size={16} /> Watching</span>
        <button className="icon-button" onClick={() => setAdding(!adding)} aria-label={adding ? 'Close company search' : 'Add company'} aria-expanded={adding}><Icon name={adding ? 'close' : 'plus'} size={17} /></button></div>
        {watched.length === 0 && <p className="home-note">Keep the companies you care about close. Their new roles will appear here.</p>}
        {watched.map(company => <div className="watch-row" key={company.slug}><span className="company-monogram">{company.name.slice(0, 2).toUpperCase()}</span>
          <Link to={`/jobs?company=${encodeURIComponent(company.slug)}`}>{company.name}<small>{companies.find(c => c.slug === company.slug)?.count ?? 0} open roles</small></Link>
          <button className="icon-button" aria-label={`Unfollow ${company.name}`} onClick={() => toggleWatch(company.slug, company.name)}><Icon name="close" size={13} /></button></div>)}
        {adding && <><div className="watch-search"><input autoFocus aria-label="Find a company to follow" placeholder="Find a company…" value={query} onChange={e => setQuery(e.target.value)} /></div>
          <div className="watch-options">{companies.filter(c => !watched.some(w => w.slug === c.slug) && c.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8).map(company =>
            <button key={company.slug} onClick={() => { toggleWatch(company.slug, company.name); setAdding(false); setQuery(''); }}>{company.name}<Icon name="plus" size={14} /></button>)}</div>
          {companies.length === 0 && <p className="home-note">Companies will appear once jobs have loaded.</p>}</>}
        {!adding && <button className="button-secondary full-width mt-5" onClick={() => setAdding(true)}><Icon name="plus" size={15} />Add company</button>}
      </section>
      {watched.length > 0 && !alertsDismissed && localStorage.getItem('nightjar_watch_alerts') !== 'true' ?
        <div className="alert-setup"><Icon name="bell" size={18} /><p>Want a heads-up when new roles appear?</p>
          <div className="flex items-center gap-4"><Link className="text-button" to="/settings">Set up alerts <Icon name="arrow" size={14} /></Link>
            <button className="muted text-xs" onClick={() => { localStorage.setItem('nightjar_alert_setup_dismissed','true'); setAlertsDismissed(true); }}>Later</button></div></div>
        : <p className="home-note">A quieter way to keep up.<br />Watch updates stay here, ready when you are.</p>}
    </aside></div>
  </div>;
}
