import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useToast } from '@/components/Toast';
import { Icon } from '@/components/Icon';
import { OutcomeDialog } from '@/outcomes/OutcomeDialog';
import { transitionApplicationStatus } from '@/outcomes/outcome-service';
import { statusNeedsOutcomePrompt, type OutcomeDetails, type PipelineStatus } from '@/outcomes/types';
import { exportApplicationsCSV } from '@/export/export-csv';
import { saveFile } from '@/export/file-save';
import { openExternal } from '@/lib/platform';

const stages: { value: PipelineStatus; label: string }[] = [
  { value: 'saved', label: 'Saved' }, { value: 'applied', label: 'Applied' },
  { value: 'oa', label: 'Assessment' }, { value: 'phone', label: 'Phone interview' },
  { value: 'onsite', label: 'Final interview' }, { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' }, { value: 'ghosted', label: 'No response' },
];
type View = 'all' | 'saved' | 'progress' | 'archived';
interface Row {
  id: string; data: string; company: string; title: string; url: string; closed_at: string | null;
  status: PipelineStatus; applied_at: string | null; next_action: string | null;
  next_action_at: string | null; deadline: string | null; notes: string | null;
  interview_count: number; offer_count: number;
}
export function PipelineView(): React.ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('view') === 'saved' ? 'saved' : 'all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'recent' | 'company' | 'due'>('recent');
  const [expanded, setExpanded] = useState<string | null>(() => new URLSearchParams(window.location.search).get('job'));
  const [pending, setPending] = useState<{ row: Row; status: PipelineStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const refresh = (): void => setRevision(n => n + 1);
  useEffect(() => {
    let cancelled = false;
    void db.query<Row>(`SELECT p.id,p.data,p.closed_at,a.status,a.applied_at,a.next_action,a.next_action_at,a.deadline,a.notes,
      (SELECT COUNT(*) FROM application_outcome_events e WHERE e.posting_id=p.id AND e.outcome='interview') AS interview_count,
      (SELECT COUNT(*) FROM application_outcome_events e WHERE e.posting_id=p.id AND e.outcome='offer') AS offer_count
      FROM applications a INNER JOIN postings_cache p ON p.id=a.posting_id
      WHERE a.status NOT IN ('new','skipped') ORDER BY a.updated_at DESC`).then(result => {
        if (cancelled) return;
        setRows(result.flatMap(row => {
          try { const data = JSON.parse(row.data) as Record<string, string>;
            return [{ ...row, company: data.company ?? '', title: data.title ?? '', url: data.url ?? '' }];
          } catch { return []; }
        })); setLoading(false);
      }).catch(() => { if (!cancelled) { setError('Could not load your applications. Please reopen this page.'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [db, revision]);
  const filtered = useMemo(() => rows.filter(row => {
    if (view === 'saved' && row.status !== 'saved') return false;
    if (view === 'progress' && ['saved','rejected','ghosted'].includes(row.status)) return false;
    if (view === 'archived' && !['rejected','ghosted'].includes(row.status)) return false;
    return `${row.company} ${row.title}`.toLowerCase().includes(search.toLowerCase());
  }).sort((a,b) => sort === 'company' ? a.company.localeCompare(b.company)
    : sort === 'due' ? (a.next_action_at || a.deadline || '9999').localeCompare(b.next_action_at || b.deadline || '9999') : 0), [rows, view, search, sort]);
  const update = useCallback(async (id: string, field: 'notes' | 'applied_at' | 'next_action' | 'next_action_at' | 'deadline', value: string): Promise<void> => {
    try {
      await db.run(`UPDATE applications SET ${field}=?, updated_at=? WHERE posting_id=?`, [value || null, new Date().toISOString(), id]);
      setRevision(n => n + 1);
    } catch { toast('Could not save your change. Please try again.', 'error'); }
  }, [db, toast]);
  const commit = async (row: Row, status: PipelineStatus, details: OutcomeDetails = {}): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await transitionApplicationStatus(db, row.id, status, details); setPending(null); refresh(); }
    catch { setError('Could not change the stage. Please try again.'); }
    finally { setBusy(false); }
  };
  const changeStage = (row: Row, status: PipelineStatus): void => {
    if (row.status === status) return;
    if (statusNeedsOutcomePrompt(status)) setPending({ row, status });
    else void commit(row, status);
  };
  return <div className="tracker-page">
    <div className="tracker-top"><div className="page-heading"><p className="eyebrow">ONE PLACE FOR YOUR NEXT STEPS</p><h1>Your applications</h1><p>From a possibility to an offer. Keep it all here.</p></div>
      <button className="button-secondary" onClick={() => setAdding(!adding)} aria-label={adding ? 'Close new application' : 'Add application'} aria-expanded={adding}><Icon name={adding ? 'close' : 'plus'} size={15} /><span className="hidden sm:inline">Add application</span></button></div>
    {error && <p role="alert" className="connection-notice">{error}</p>}
    {adding && <ManualApplication onDone={() => { setAdding(false); refresh(); }} />}
    <div className="tracker-stats" aria-label="Application milestones">
      <div><strong>{rows.filter(r => r.applied_at).length}</strong><span>Applied</span></div>
      <div><strong>{rows.filter(r => r.interview_count > 0 || ['phone','onsite'].includes(r.status)).length}</strong><span>Interviews</span></div>
      <div><strong>{rows.filter(r => r.offer_count > 0 || r.status === 'offer').length}</strong><span>Offers</span></div>
    </div>
    <div className="tracker-toolbar"><div className="segmented" aria-label="Application views">
      {([{ value: 'all', label: 'All' }, { value: 'saved', label: 'Saved' }, { value: 'progress', label: 'In progress' }, { value: 'archived', label: 'Archived' }] as const).map(item =>
        <button key={item.value} aria-pressed={view === item.value} onClick={() => setView(item.value)}>{item.label}</button>)}
    </div><div className="flex items-center gap-4"><input className="tracker-search" aria-label="Search applications" placeholder="Find an application…" value={search} onChange={e => setSearch(e.target.value)} />
      <button className="icon-button" aria-label="Export applications as CSV" onClick={() => {
        void exportApplicationsCSV(db).then(csv => saveFile({ content: csv, defaultName: 'nightjar-applications.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] })).catch(() => toast('Could not export applications.', 'error'));
      }}><Icon name="download" size={17} /></button></div></div>
    {loading ? <div className="skeleton-block" role="status" aria-label="Loading applications" /> : filtered.length === 0 ?
      <div className="tracker-empty"><Icon name="tracker" size={30} /><h2>{rows.length ? 'A little too narrow.' : 'Your next chapter starts with a save.'}</h2>
        <p>{rows.length ? 'Try a different view or search.' : 'Save a role in Jobs, or add an application you already started.'}</p>
        <Link className="button-primary" to="/jobs">Explore jobs <Icon name="arrow" size={16} /></Link></div> :
      <div className="tracker-table-wrap"><table className="tracker-table"><thead><tr>
        <th style={{ width: '32%' }} aria-sort={sort === 'company' ? 'ascending' : 'none'}><button onClick={() => setSort(sort === 'company' ? 'recent' : 'company')}>Company / role {sort === 'company' ? '↑' : ''}</button></th>
        <th style={{ width: '17%' }}>Stage</th><th style={{ width: '15%' }}>Applied</th><th style={{ width: '21%' }}>Next step</th>
        <th style={{ width: '15%' }} aria-sort={sort === 'due' ? 'ascending' : 'none'}><button onClick={() => setSort(sort === 'due' ? 'recent' : 'due')}>Due {sort === 'due' ? '↑' : ''}</button></th>
      </tr></thead><tbody>{filtered.map(row => <Fragment key={row.id}>
        <tr><td><button className="tracker-title" aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)}><strong>{row.company}{row.closed_at && <small className="closed-label">Posting closed</small>}</strong><span>{row.title}</span></button></td>
          <td><select aria-label={`Stage for ${row.company}`} value={row.status} disabled={busy} onChange={e => changeStage(row, e.target.value as PipelineStatus)}>{stages.map(stage => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></td>
          <td><DateCell label={`Applied date for ${row.company}`} value={row.applied_at} onSave={value => void update(row.id, 'applied_at', value)} /></td>
          <td><EditableCell label={`Next step for ${row.company}`} value={row.next_action} placeholder="Add next step" onSave={value => void update(row.id, 'next_action', value)} /></td>
          <td><DateCell label={`Due date for ${row.company}`} value={row.next_action_at || row.deadline} onSave={value => void update(row.id, row.next_action_at || !row.deadline ? 'next_action_at' : 'deadline', value)} /></td>
        </tr>
        {expanded === row.id && <tr><td colSpan={5} className="notes-cell">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4"><div><strong>{row.title}</strong><p className="muted text-xs mt-1">{row.company}{row.closed_at ? ' · Public posting closed; your application stays here.' : ''}</p></div>
            <button className="button-secondary" onClick={() => { void openExternal(row.url); }}>Open posting <Icon name="external" size={14} /></button></div>
          <div className="mobile-tracker-fields"><label>Applied<DateCell label={`Edit applied date for ${row.company}`} value={row.applied_at} onSave={v => void update(row.id,'applied_at',v)} /></label>
            <label>Next step<EditableCell label={`Edit next step for ${row.company}`} value={row.next_action} placeholder="Add next step" onSave={v => void update(row.id,'next_action',v)} /></label>
            <label>Due<DateCell label={`Edit due date for ${row.company}`} value={row.next_action_at || row.deadline} onSave={v => void update(row.id,row.next_action_at || !row.deadline ? 'next_action_at' : 'deadline',v)} /></label></div>
          <label className="text-xs muted">Notes<Notes key={`${row.id}-${row.notes}`} value={row.notes} onSave={value => void update(row.id, 'notes', value)} /></label>
        </td></tr>}
      </Fragment>)}</tbody></table></div>}
    <p className="home-note">Saved on this device. Export a copy whenever you need it.</p>
    {pending && <OutcomeDialog company={pending.row.company} title={pending.row.title} status={pending.status} busy={busy}
      onCancel={() => setPending(null)} onSubmit={details => { void commit(pending.row, pending.status, details); }} />}
  </div>;
}
function EditableCell({ label, value, placeholder, onSave }: { label: string; value: string | null; placeholder: string; onSave: (value: string) => void }): React.ReactNode {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return <input aria-label={label} value={draft} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onBlur={() => { if (draft !== (value ?? '')) onSave(draft); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(value ?? ''); }} />;
}
function DateCell({ label, value, onSave }: { label: string; value: string | null; onSave: (value: string) => void }): React.ReactNode {
  return <input type="date" aria-label={label} value={value?.slice(0, 10) ?? ''} onChange={e => onSave(e.target.value)} />;
}
function Notes({ value, onSave }: { value: string | null; onSave: (value: string) => void }): React.ReactNode {
  const [draft, setDraft] = useState(value ?? '');
  return <div><textarea className="mt-2" aria-label="Application notes" value={draft} onChange={e => setDraft(e.target.value)} placeholder="People you spoke with, questions to ask, things to remember…" />
    <button className="button-secondary mt-2" disabled={draft === (value ?? '')} onClick={() => onSave(draft)}>Save notes</button></div>;
}
function ManualApplication({ onDone }: { onDone: () => void }): React.ReactNode {
  const { db } = useDatabase(); const { toast } = useToast(); const [busy, setBusy] = useState(false);
  return <form className="manual-application" onSubmit={e => {
    e.preventDefault(); if (busy) return;
    const form = new FormData(e.currentTarget); const company = String(form.get('company')).trim(); const title = String(form.get('title')).trim(); const url = String(form.get('url')).trim();
    if (!company || !title) return;
    try { if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error(); } catch { toast('Enter a valid company job URL.', 'error'); return; }
    const id = `local-${crypto.randomUUID()}`; const now = new Date().toISOString();
    const data = JSON.stringify({ id, company, title, url, source: 'manual', company_slug: '', location: '', locations: [], first_seen_at: now, closed_at: null });
    setBusy(true);
    void db.batch([{ sql: 'INSERT INTO postings_cache (id,data,first_seen_at,synced_at) VALUES (?,?,?,?)', params: [id,data,now,now] },
      { sql: "INSERT INTO applications (posting_id,status,created_at,updated_at) VALUES (?,'saved',?,?)", params: [id,now,now] }])
      .then(onDone).catch(() => toast('Could not add the application. Please try again.', 'error')).finally(() => setBusy(false));
  }}><label>Company<input name="company" required autoFocus placeholder="Company name" /></label><label>Role<input name="title" required placeholder="Position title" /></label><label>Job URL<input name="url" required type="url" placeholder="https://…" /></label><button className="button-primary" disabled={busy}>Add to tracker</button></form>;
}
