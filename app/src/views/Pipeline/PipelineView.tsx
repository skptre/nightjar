import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useToast } from '@/components/Toast';
import { Glyph } from '@/components/Icon';
import { OutcomeDialog } from '@/outcomes/OutcomeDialog';
import {
  annotateLatestOutcome, restoreApplicationStatus, snapshotApplicationStatus, transitionApplicationStatus,
} from '@/outcomes/outcome-service';
import { statusNeedsOutcomePrompt, type OutcomeDetails, type PipelineStatus } from '@/outcomes/types';
import { openExternal } from '@/lib/platform';
import { useTrackerQuery } from '@/lib/search';
import { Panel } from '@/motion/Panel';
import { afterRender, playFlip, snapshotRows, tilt, useGlide, useLayer } from '@/motion/motion';
import { relativeDue, shortDate, stageOf, STAGES, TONE_DOT, toastDot } from './stages';

type Tab = 'All' | 'Saved' | 'Active' | 'Offer' | 'Closed';
const TABS: { tab: Tab; test: (status: string) => boolean }[] = [
  { tab: 'All', test: () => true },
  { tab: 'Saved', test: (s) => s === 'saved' },
  { tab: 'Active', test: (s) => ['applied', 'oa', 'phone', 'onsite'].includes(s) },
  { tab: 'Offer', test: (s) => s === 'offer' },
  { tab: 'Closed', test: (s) => ['rejected', 'ghosted'].includes(s) },
];
const MENU_H = STAGES.length * 40 + 12;
const byId = (id: string): string => `[data-id="${id.replace(/["\\]/g, '\\$&')}"]`;

interface Row {
  id: string; data: string; company: string; title: string; url: string; closed_at: string | null;
  status: PipelineStatus; applied_at: string | null; next_action: string | null;
  next_action_at: string | null; deadline: string | null; notes: string | null;
  interview_count: number; offer_count: number;
}

export function PipelineView(): React.ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const query = useTrackerQuery();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<Tab>(() => new URLSearchParams(window.location.search).get('view') === 'saved' ? 'Saved' : 'All');
  const [sort, setSort] = useState<'recent' | 'company' | 'due'>('recent');
  const [expanded, setExpanded] = useState<string | null>(() => new URLSearchParams(window.location.search).get('job'));
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; up: boolean } | null>(null);
  const [bump, setBump] = useState<{ id: string; n: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<{ row: Row; status: PipelineStatus } | null>(null);
  const lastOutcome = useRef<{ row: Row; status: PipelineStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entrance, setEntrance] = useState<{ prev: Set<string> | null; name: string } | null>({ prev: null, name: 'rowIn' });
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const segiRef = useRef<HTMLSpanElement>(null);
  const segFrom = useRef<{ x: number; w: number } | null>(null);
  const flipSnap = useRef<Map<string, number> | null>(null);
  const glide = useGlide();
  const layerOpen = adding || outcome !== null;
  useLayer(layerOpen);
  if (outcome) lastOutcome.current = outcome;
  const refresh = (): void => setRevision(n => n + 1);

  useEffect(() => {
    let cancelled = false;
    void db.query<Row>(`SELECT p.id,p.data,p.closed_at,a.status,a.applied_at,a.next_action,a.next_action_at,a.deadline,a.notes,
      (SELECT COUNT(*) FROM application_outcome_events e WHERE e.posting_id=p.id AND e.outcome='interview') AS interview_count,
      (SELECT COUNT(*) FROM application_outcome_events e WHERE e.posting_id=p.id AND e.outcome='offer') AS offer_count
      FROM applications a INNER JOIN postings_cache p ON p.id=a.posting_id
      WHERE a.status NOT IN ('new','skipped') ORDER BY a.created_at DESC, p.id`).then(result => {
        if (cancelled) return;
        setRows(result.flatMap(row => {
          try { const data = JSON.parse(row.data) as Record<string, string>;
            return [{ ...row, company: data.company ?? '', title: data.title ?? '', url: data.url ?? '' }];
          } catch { return []; }
        })); setLoading(false);
      }).catch(() => { if (!cancelled) { setError('Could not load your applications. Please reopen this page.'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [db, revision]);
  useEffect(() => {
    if (!entrance) return;
    const timer = setTimeout(() => setEntrance(null), 1200);
    return () => clearTimeout(timer);
  }, [entrance]);
  // A link from Home lands on its application, opened and in view.
  const scrolledTo = useRef(false);
  useEffect(() => {
    if (scrolledTo.current || loading || !expanded) return;
    scrolledTo.current = true;
    requestAnimationFrame(() => listRef.current?.querySelector(byId(expanded))?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }));
  }, [loading, expanded]);

  const due = (row: Row): string | null => row.next_action_at || row.deadline;
  const searched = useMemo(() => rows.filter(row => `${row.company} ${row.title}`.toLowerCase().includes(query.trim().toLowerCase())), [rows, query]);
  const filtered = useMemo(() => searched.filter(row => TABS.find(t => t.tab === tab)!.test(row.status))
    .sort((a, b) => sort === 'company' ? a.company.localeCompare(b.company)
      : sort === 'due' ? (due(a) || '9999').localeCompare(due(b) || '9999') : 0), [searched, tab, sort]);
  const upcoming = rows.filter(row => due(row) && !['rejected', 'ghosted'].includes(row.status))
    .sort((a, b) => due(a)!.localeCompare(due(b)!)).slice(0, 3);

  const update = useCallback(async (id: string, field: 'notes' | 'applied_at' | 'next_action' | 'next_action_at' | 'deadline', value: string): Promise<void> => {
    try {
      await db.run(`UPDATE applications SET ${field}=?, updated_at=? WHERE posting_id=?`, [value || null, new Date().toISOString(), id]);
      setRevision(n => n + 1);
    } catch { toast('Could not save your change. Please try again.', 'error'); }
  }, [db, toast]);

  /** Tab change: the indicator travels to the new tab, rows that stay slide into place. */
  const pickTab = (next: Tab): void => {
    if (next === tab) return;
    const cur = tabsRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    segFrom.current = cur ? { x: cur.offsetLeft, w: cur.offsetWidth } : null;
    flipSnap.current = snapshotRows(listRef.current, '.trow');
    glide.hide();
    setMenu(null);
    setEntrance(e => ({ prev: new Set(filtered.map(r => r.id)), name: e?.name === 'rowIn' ? 'rowIn2' : 'rowIn' }));
    setTab(next);
    afterRender(() => { if (flipSnap.current && playFlip(listRef.current, '.trow', flipSnap.current, 620)) flipSnap.current = null; });
  };
  useLayoutEffect(() => {
    const from = segFrom.current, c = tabsRef.current, i = segiRef.current;
    const b = c?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!from || !c || !i || !b || !b.offsetWidth) return;
    segFrom.current = null;
    i.style.transition = 'none';
    i.style.transform = `translateX(${String(from.x)}px)`;
    i.style.width = `${String(from.w)}px`;
    i.style.opacity = '1';
    c.classList.add('sliding');
    void i.getBoundingClientRect();
    i.style.transition = 'transform 520ms var(--spring), width 520ms var(--spring)';
    i.style.transform = `translateX(${String(b.offsetLeft)}px)`;
    i.style.width = `${String(b.offsetWidth)}px`;
    const timer = setTimeout(() => { c.classList.remove('sliding'); i.style.opacity = '0'; }, 540);
    return () => clearTimeout(timer);
  }, [tab]);

  /** The stage menu lives at panel level, under its pill (or above it near the bottom). */
  const toggleMenu = (e: React.MouseEvent<HTMLElement>, id: string): void => {
    e.stopPropagation();
    const panel = panelRef.current;
    if (!panel || menu?.id === id) { setMenu(null); return; }
    const pr = e.currentTarget.getBoundingClientRect(), mr = panel.getBoundingClientRect();
    let y = pr.bottom - mr.top + 8;
    const up = panel.offsetHeight > 0 && y + MENU_H > panel.offsetHeight - 12;
    if (up) y = pr.top - mr.top - 8 - MENU_H;
    setMenu({ id, x: pr.left - mr.left, y: Math.max(8, y), up });
  };

  /** Stage changes apply at once; the toast offers Undo, and notes for outcomes worth keeping. */
  const pickStage = async (row: Row, status: PipelineStatus): Promise<void> => {
    setMenu(null);
    if (row.status === status || busy) return;
    setBusy(true); setError(null);
    try {
      const snapshot = await snapshotApplicationStatus(db, row.id);
      await transitionApplicationStatus(db, row.id, status);
      setBump(b => ({ id: row.id, n: (b?.n ?? 0) + 1 }));
      setRows(current => current.map(r => r.id === row.id ? { ...r, status } : r));
      refresh();
      toast(`${row.company} moved to ${stageOf(status).label}`, 'success', {
        dot: toastDot(status),
        actions: [
          ...(statusNeedsOutcomePrompt(status) ? [{ label: 'Add notes', onClick: () => setOutcome({ row, status }) }] : []),
          { label: 'Undo', onClick: () => {
            void restoreApplicationStatus(db, snapshot).then(() => {
              setBump(b => ({ id: row.id, n: (b?.n ?? 0) + 1 }));
              refresh();
              toast(`Moved back to ${stageOf(snapshot.status).label}`, 'success', { dot: toastDot(snapshot.status) });
            }).catch(() => toast('Could not undo that move.', 'error'));
          } },
        ],
      });
    } catch { setError('Could not change the stage. Please try again.'); }
    finally { setBusy(false); }
  };

  const saveOutcome = async (details: OutcomeDetails): Promise<void> => {
    if (!outcome || busy) return;
    setBusy(true);
    try {
      await annotateLatestOutcome(db, outcome.row.id, details);
      toast(`Notes saved for ${outcome.row.company}`, 'success', { dot: toastDot(outcome.status) });
      setOutcome(null); refresh();
    } catch { toast('Could not save those notes. Please try again.', 'error'); }
    finally { setBusy(false); }
  };

  const focusRow = (id: string): void => {
    setExpanded(id);
    listRef.current?.querySelector(byId(id))?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };
  const menuRow = menu ? rows.find(r => r.id === menu.id) : null;
  const sheetOutcome = outcome ?? lastOutcome.current;
  let fresh = 0;

  return <div className="page page-enter">
    <Panel ref={panelRef} className={`tracker-panel depth ${layerOpen ? 'behind-soft' : ''}`} aria-label="Tracker" {...(layerOpen ? { inert: true } : {})}>
      {menu && <button type="button" aria-label="Close menu" tabIndex={-1} onClick={() => setMenu(null)}
        style={{ all: 'unset', position: 'absolute', inset: 0, zIndex: 10, cursor: 'default' }} />}
      <div className="list-head" style={{ paddingBottom: 0 }}>
        <div className="title">
          <h1 className="h1">Applications</h1>
          <span className="count">{loading ? '' : `${String(filtered.length)} ${filtered.length === 1 ? 'application' : 'applications'}`}</span>
        </div>
        <div className="tools" style={{ gap: 12 }}>
          <div ref={tabsRef} className="tabs" aria-label="Application views">
            <span ref={segiRef} className="segi" aria-hidden="true" />
            {TABS.map(({ tab: t, test }) => <button key={t} type="button" className="tab" aria-pressed={tab === t} onClick={() => pickTab(t)}>
              <span>{t}</span><span className="n">{searched.filter(r => test(r.status)).length}</span>
            </button>)}
          </div>
          <button type="button" className="icb" onClick={() => setAdding(true)} aria-haspopup="dialog" style={{ height: 42, padding: '0 18px' }}>
            <Glyph name="plus" size={13} />Add
          </button>
        </div>
      </div>
      {error && <p role="alert" className="kicker" style={{ padding: '12px 36px 0', position: 'relative', zIndex: 1 }}>{error}</p>}

      {(loading || upcoming.length > 0) && <section className="upnext" aria-label="Up next">
        <h2 className="kicker">Up next</h2>
        <div className="cards3">{loading ? [0, 1, 2].map(i => <div key={i} className="card" style={{ height: 132 }}><span className="sk" style={{ width: '40%' }} /><span className="sk" style={{ width: '80%', height: 14 }} /><span className="sk" style={{ width: '50%' }} /></div>)
          : upcoming.map((row, i) => {
            const rel = relativeDue(due(row)!);
            return <button key={row.id} type="button" className="card tilt" onMouseMove={tilt.onMouseMove} onMouseLeave={tilt.onMouseLeave}
              onClick={() => focusRow(row.id)} style={{ animation: 'rowIn 600ms var(--out) backwards', animationDelay: `${String(i * 50)}ms`, cursor: 'pointer' }}>
              <span className={`card-when ${rel.hot ? 'hot' : ''}`}>{rel.label}</span>
              <span className="card-next">{row.next_action || 'Application deadline'}</span>
              <span className="card-co"><span className="mark sm" aria-hidden="true">{row.company.charAt(0).toUpperCase()}</span><span>{row.company}</span></span>
            </button>;
          })}</div>
      </section>}

      <div className="tcolhead" style={{ paddingTop: upcoming.length || loading ? 0 : 20 }}>
        <div className="colhead cols tracker-cols">
          <span aria-sort={sort === 'company' ? 'ascending' : 'none'}><button type="button" onClick={() => setSort(sort === 'company' ? 'recent' : 'company')}>Role{sort === 'company' && <Glyph name="down" size={11} />}</button></span>
          <span>Stage</span><span className="c-next">Next step</span>
          <span className="c-due" style={{ textAlign: 'right' }} aria-sort={sort === 'due' ? 'ascending' : 'none'}><button type="button" onClick={() => setSort(sort === 'due' ? 'recent' : 'due')}>{sort === 'due' && <Glyph name="down" size={11} />}Due</button></span>
        </div>
      </div>

      <div className="list-area">
        {loading ? <div className="list-scroll scroll" role="status" aria-label="Loading applications">
          {Array.from({ length: 6 }, (_, i) => <div className="skel-row" key={i}><span className="mark" /><span className="sk" style={{ width: `${String(30 + i * 5)}%` }} /><span className="sk" style={{ width: '12%', marginLeft: 'auto' }} /></div>)}
        </div> : filtered.length === 0 ? (rows.length === 0 ? <div className="empty">
          <div className="stack-art" aria-hidden="true">
            <span style={{ left: 22, right: 22, top: 0, height: 60, border: '1px solid rgba(var(--fg-rgb),.1)' }} />
            <span style={{ left: 10, right: 10, top: 14, height: 62, border: '1px solid rgba(var(--fg-rgb),.18)' }} />
            <span style={{ left: 0, right: 0, top: 30, height: 64, border: '1px solid rgba(var(--fg-rgb),.32)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Glyph name="bookmark" size={20} width={1.4} /></span>
          </div>
          <h2>Your next chapter starts with a save.</h2>
          <p>Bookmark roles in Jobs and they land here, ready to track from saved to offer.</p>
          <div className="acts"><Link className="solid" to="/jobs" style={{ height: 42 }}>Browse jobs</Link><button type="button" className="ghost" onClick={() => setAdding(true)}>Add one yourself</button></div>
        </div> : <div className="empty">
          <h2>{query ? 'Nothing matches that search.' : 'Nothing here yet.'}</h2>
          <p>{query ? 'Try a company or role name.' : `No applications are ${tab === 'Offer' ? 'at the offer stage' : tab === 'Closed' ? 'closed' : tab === 'Saved' ? 'only saved' : 'in progress'} right now.`}</p>
          <div className="acts"><button type="button" className="ghost" onClick={() => pickTab('All')}>Show all</button></div>
        </div>) : <div ref={listRef} className="list-scroll scroll fade-list" style={{ paddingBottom: 160 }}
          onScroll={() => { if (menu) setMenu(null); }} onMouseMove={glide.onMouseMove} onMouseLeave={glide.onMouseLeave}>
          <div className="list-inner">
            <div ref={glide.glideRef} className="glide" aria-hidden="true" />
            {filtered.map((row, i) => {
              const open = expanded === row.id;
              const stage = stageOf(row.status);
              const d = due(row);
              const rel = d ? relativeDue(d) : null;
              let anim: string | undefined;
              if (entrance) {
                if (!entrance.prev) { if (i < 13) anim = `rowIn 560ms var(--out) ${String(i * 32)}ms backwards`; }
                else if (!entrance.prev.has(row.id)) anim = `${entrance.name} 560ms var(--out) ${String(60 + fresh++ * 30)}ms backwards`;
              }
              return <div key={row.id} className={`trow ${open ? 'open' : ''}`} data-id={row.id} data-glide data-noglide={open ? '' : undefined} style={anim ? { animation: anim } : undefined}>
                <div className="trow-line cols tracker-cols" onClick={() => setExpanded(open ? null : row.id)}>
                  <button type="button" className="trow-title" aria-expanded={open} onClick={e => { e.stopPropagation(); setExpanded(open ? null : row.id); }}>
                    <span className="mark" aria-hidden="true">{row.company.charAt(0).toUpperCase()}</span>
                    <span><span className="jrow-title">{row.title}</span><span className="jrow-co">{row.company}</span>{row.closed_at && <span className="closed-tag">Closed</span>}</span>
                  </button>
                  <div>
                    <button type="button" className={`pill st-${stage.tone}`} aria-haspopup="menu" aria-expanded={menu?.id === row.id}
                      aria-label={`Stage for ${row.company}: ${stage.label}`} disabled={busy} onClick={e => toggleMenu(e, row.id)}
                      style={{ animation: bump?.id === row.id ? `pillPop${bump.n % 2 ? 'A' : 'B'} 520ms var(--bounce)` : undefined }}>
                      <span className="stdot" style={{ background: TONE_DOT[stage.tone] }} />{stage.label}<Glyph name="down" size={10} width={1.5} />
                    </button>
                  </div>
                  <span className={`trow-next c-next ${row.next_action ? '' : 'empty-next'}`}>{row.next_action || 'Add a next step'}</span>
                  <span className={`trow-due c-due ${rel?.hot ? 'hot' : ''}`}>{d && rel ? `${shortDate(d)} · ${rel.rel}` : ''}</span>
                </div>
                <div className="exp" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}><div>
                  {open && <div className="trow-body fadein">
                    <label><span className="flab">Next step</span>
                      <EditableField label={`Next step for ${row.company}`} value={row.next_action} placeholder="What happens next?" onSave={v => void update(row.id, 'next_action', v)} /></label>
                    <label><span className="flab">Due</span>
                      <input className="fld sm" type="date" aria-label={`Due date for ${row.company}`} value={d?.slice(0, 10) ?? ''}
                        onChange={e => void update(row.id, row.next_action_at || !row.deadline ? 'next_action_at' : 'deadline', e.target.value)} /></label>
                    <label className="full"><span className="flab">Notes</span>
                      <Notes key={`${row.id}-${row.notes ?? ''}`} value={row.notes} onSave={v => void update(row.id, 'notes', v)} /></label>
                    <div className="trow-meta full">
                      <span aria-label="Application milestones" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Applied
                          <input className="fld sm" type="date" style={{ width: 160, height: 34 }} aria-label={`Applied date for ${row.company}`} value={row.applied_at?.slice(0, 10) ?? ''} onChange={e => void update(row.id, 'applied_at', e.target.value)} /></label>
                        {row.interview_count > 0 && <span>{row.interview_count} {row.interview_count === 1 ? 'interview' : 'interviews'}</span>}
                        {row.offer_count > 0 && <span>{row.offer_count} {row.offer_count === 1 ? 'offer' : 'offers'}</span>}
                        {row.closed_at && <span>Public posting closed. Your application stays here.</span>}
                      </span>
                      {row.url && <button type="button" className="link" onClick={() => void openExternal(row.url)}><span className="u">Open posting</span><Glyph name="ext" size={13} /></button>}
                    </div>
                  </div>}
                </div></div>
              </div>;
            })}
          </div>
        </div>}
      </div>

      {menu && menuRow && <div role="menu" aria-label={`Stage for ${menuRow.company}`} className="menu"
        style={{ left: menu.x, top: menu.y, transformOrigin: menu.up ? '22px 100%' : '22px 0' }}>
        {STAGES.map((s, k) => <button key={s.value} type="button" role="menuitemradio" aria-checked={s.value === menuRow.status} className="mi"
          style={{ animationDelay: `${String(40 + k * 24)}ms` }} onClick={() => void pickStage(menuRow, s.value)}>
          <span><span className="stdot" style={{ width: 7, height: 7, background: TONE_DOT[s.tone] }} />{s.label}</span>
          <Glyph name="check" size={12} width={1.8} className={s.value === menuRow.status ? 'tick' : ''} style={{ opacity: s.value === menuRow.status ? 1 : 0 }} />
        </button>)}
      </div>}
    </Panel>

    {layerOpen && <button type="button" className="scrim" aria-label="Close" tabIndex={-1} onClick={() => { if (!busy) { setAdding(false); setOutcome(null); } }} />}
    <AddSheet open={adding} onClose={() => setAdding(false)} onAdded={(company, status) => {
      setAdding(false);
      setEntrance(e => ({ prev: new Set(filtered.map(r => r.id)), name: e?.name === 'rowIn' ? 'rowIn2' : 'rowIn' }));
      refresh();
      toast(`${company} added to your tracker`, 'success', { dot: toastDot(status) });
    }} />
    {sheetOutcome && <OutcomeDialog open={outcome !== null} company={sheetOutcome.row.company} title={sheetOutcome.row.title} status={sheetOutcome.status} busy={busy}
      onCancel={() => setOutcome(null)} onSubmit={details => void saveOutcome(details)} />}
  </div>;
}

function EditableField({ label, value, placeholder, onSave }: { label: string; value: string | null; placeholder: string; onSave: (value: string) => void }): React.ReactNode {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return <input className="fld sm" aria-label={label} value={draft} placeholder={placeholder} onChange={e => setDraft(e.target.value)}
    onBlur={() => { if (draft !== (value ?? '')) onSave(draft); }}
    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(value ?? ''); }} />;
}

function Notes({ value, onSave }: { value: string | null; onSave: (value: string) => void }): React.ReactNode {
  const [draft, setDraft] = useState(value ?? '');
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
    <textarea className="fld" aria-label="Application notes" value={draft} onChange={e => setDraft(e.target.value)} style={{ height: 96 }}
      placeholder="People you spoke with, questions to ask, things to remember…" />
    <button type="button" className="ghost sm" disabled={draft === (value ?? '')} onClick={() => onSave(draft)}>Save notes</button>
  </div>;
}

function AddSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (company: string, status: PipelineStatus) => void }): React.ReactNode {
  const { db } = useDatabase(); const { toast } = useToast();
  const [form, setForm] = useState({ company: '', title: '', url: '' });
  const [stage, setStage] = useState<'saved' | 'applied'>('applied');
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setForm({ company: '', title: '', url: '' }); setStage('applied');
    requestAnimationFrame(() => firstRef.current?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  const locked = !form.company.trim() || !form.title.trim() || busy;
  const submit = (): void => {
    if (locked) return;
    const company = form.company.trim(), title = form.title.trim(), url = form.url.trim();
    if (url) {
      try { if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error(); } catch { toast('Enter a full link, starting with https://', 'error'); return; }
    }
    const id = `local-${crypto.randomUUID()}`; const now = new Date().toISOString();
    const data = JSON.stringify({ id, company, title, url, source: 'manual', company_slug: '', location: '', locations: [], first_seen_at: now, closed_at: null });
    setBusy(true);
    void db.batch([{ sql: 'INSERT INTO postings_cache (id,data,first_seen_at,synced_at) VALUES (?,?,?,?)', params: [id, data, now, now] },
      { sql: 'INSERT INTO applications (posting_id,status,applied_at,created_at,updated_at) VALUES (?,?,?,?,?)', params: [id, stage, stage === 'applied' ? now : null, now, now] }])
      .then(() => onAdded(company, stage)).catch(() => toast('Could not add the application. Please try again.', 'error')).finally(() => setBusy(false));
  };
  return <div role="dialog" aria-modal="true" aria-label="Add an application" className={`sheet form-sheet ${open ? 'on' : ''}`} {...(!open ? { inert: true } : {})}>
    <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 className="sheet-title">Add an application</h2>
        <button type="button" className="icb round" onClick={onClose} aria-label="Close"><Glyph name="close" size={13} /></button>
      </div>
      <p className="sheet-sub">For roles you found somewhere else. Fill in the rest later.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
        <label><span className="flab">Company</span><input ref={firstRef} className="fld" name="company" placeholder="Company name" value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} /></label>
        <label><span className="flab">Role</span><input className="fld" name="title" placeholder="Position title" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
      </div>
      <label style={{ display: 'block', marginTop: 16 }}><span className="flab">Link to the posting <span style={{ color: 'rgba(var(--fg-rgb),.35)' }}>(optional)</span></span>
        <input className="fld" name="url" type="url" placeholder="https://" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} /></label>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, gap: 16, flexWrap: 'wrap' }}>
        <span className="flab" style={{ margin: 0 }}>Where are you with it?</span>
        <div className="seg soft">
          {(['saved', 'applied'] as const).map(value => <button key={value} type="button" aria-pressed={stage === value} onClick={() => setStage(value)} style={{ height: 34, fontSize: 14 }}>
            <span className="stdot" style={{ width: 7, height: 7, background: TONE_DOT[value] }} />{value === 'saved' ? 'Saved' : 'Applied'}
          </button>)}
        </div>
      </div>
      <div className="sheet-actions">
        <button type="button" className="ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="solid" style={{ height: 42 }} disabled={locked}>{busy ? 'Adding…' : 'Add to tracker'}</button>
      </div>
    </form>
  </div>;
}
