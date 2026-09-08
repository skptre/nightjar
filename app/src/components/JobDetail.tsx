import { useEffect, useMemo, useRef, useState } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useToast } from './Toast';
import { Icon } from './Icon';
import { openExternal } from '@/lib/platform';
import { useWatchlist, toggleWatch } from '@/hooks/useWatchlist';
import { getJobDetails, acquisitionStatus } from '@/details/cache';
import { extractJobDetails } from '@/details/extract';
import type { JobDetails } from '@/details/types';
import { CATEGORY_OPTIONS } from '@/classify/types';
import type { PostingRowData } from '@/views/Feed/PostingRow';
import type { PostingAction } from '@/views/Feed/PostingRow';

export function JobDetail({ posting, onClose, onAction }: {
  posting: PostingRowData; onClose: () => void; onAction: (id: string, action: PostingAction) => void;
}): React.ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const watched = useWatchlist();
  const following = watched.some(c => c.slug === posting.company_slug);
  const [documentState, setDocumentState] = useState<{ id: string; details: JobDetails } | null>(null);
  const [full, setFull] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [posting.id]);
  useEffect(() => {
    let cancelled = false;
    setFull(false);
    setLoadFailed(false);
    void (async () => {
      const cached = await getJobDetails(db, posting.id);
      let details = cached?.details;
      if (!details) {
        const row = await db.queryOne<{ description: string | null; data: string }>(
          'SELECT description, data FROM postings_cache WHERE id = ?', [posting.id]);
        let status: unknown;
        try { status = JSON.parse(row?.data ?? '{}').description_status; } catch { /* unknown */ }
        details = extractJobDetails(row?.description ?? null, { acquisition: acquisitionStatus(status),
          ...(posting.compensation ? { advertisedCompensation: posting.compensation } : {}) });
      }
      if (!cancelled) setDocumentState({ id: posting.id, details });
    })().catch(() => { if (!cancelled) { setLoadFailed(true); toast('Could not load the description. You can still open the employer page.', 'error'); } });
    return () => { cancelled = true; };
  }, [db, posting.id, posting.compensation, posting.description_text, posting.description_status, toast]);
  const details = documentState?.id === posting.id ? documentState.details : null;
  const sections = useMemo(() => details ? [
    { label: 'The role', passages: details.sections.responsibilities },
    { label: 'What you bring', passages: details.sections.required },
    { label: 'Nice to have', passages: details.sections.preferred },
    { label: 'Work authorization', passages: details.authorization },
  ].filter(section => section.passages.length) : [], [details]);
  const tracked = posting.application_status && !['new', 'skipped'].includes(posting.application_status);
  const pay = posting.compensation || (details?.compensation.status === 'listed'
    ? [...new Set(details.compensation.ranges.map(range => range.label || range.evidence.text))].join(' · ')
      || details.compensation.passages.map(passage => passage.text).join('\n') : null);
  return <section className="job-detail" aria-label={`Details for ${posting.title}`} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
    <div className="detail-topline"><span>OPPORTUNITY DETAILS</span><button className="icon-button" onClick={onClose} aria-label="Close job details"><Icon name="close" /></button></div>
    <div className="detail-body">
      <div className="detail-company"><span className="company-monogram large">{posting.company.slice(0, 2).toUpperCase()}</span>
        <div><p>{posting.company}</p><span className="muted text-xs">{posting.closed_at ? 'Posting closed' : 'Open position'}</span></div>
        {posting.company_slug && <button className="icon-button" aria-label={`${following ? 'Unfollow' : 'Follow'} ${posting.company}`} aria-pressed={following}
          onClick={() => toggleWatch(posting.company_slug, posting.company)}><Icon name={following ? 'check' : 'watch'} /></button>}
      </div>
      <h2 ref={titleRef} tabIndex={-1} className="detail-title outline-none">{posting.title}</h2>
      <p className="detail-location"><Icon name="pin" size={15} />{posting.location || posting.locations.join(' · ') || 'Location not specified'}</p>
      <div className="detail-tags">{posting.category_tags.map(tag => <span key={tag}>{CATEGORY_OPTIONS.find(c => c.value === tag)?.label ?? tag}</span>)}
        {posting.term && <span>{posting.term.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())}</span>}</div>
      <div className="detail-actions"><button className="button-primary" onClick={() => {
        void openExternal(posting.url).then(ok => { if (!ok) toast('If the employer page did not open, allow pop-ups and try again.', 'error'); });
      }}>Apply on company site <Icon name="external" size={15} /></button>
        <button className="button-secondary" disabled={Boolean(tracked)} onClick={() => onAction(posting.id, 'save')}><Icon name={tracked ? 'check' : 'bookmark'} size={16} />{tracked ? 'Saved to tracker' : 'Save'}</button>
      </div>
      <div className="applied-line">{tracked && posting.application_status !== 'saved' ? <span className="muted">In your tracker · {posting.application_status}</span>
        : <><span>Already sent your application?</span><button className="text-button" onClick={() => onAction(posting.id, 'apply')}>Mark applied <Icon name="check" size={14} /></button></>}</div>
      <div className="detail-divider" />
      {pay && (pay.length > 180 ? <details className="detail-section"><summary className="cursor-pointer text-sm">Compensation <span className="muted text-xs ml-2">View source details</span></summary><p className="mt-3">{pay}</p></details>
        : <section className="detail-section"><h3>Compensation</h3><p>{pay}</p></section>)}
      {!details ? loadFailed ? <p role="status" className="document-notice">Couldn't load this description. You can still read it on the employer page.</p> : <div className="skeleton-block" role="status" aria-label="Loading description" /> : !details.document ?
        <div className="description-empty"><Icon name="external" /><h3>The full story is on the company site.</h3><p>A description isn't available here yet. You can still save this role and apply directly.</p></div> : <>
          {details.acquisition !== 'available' && <p className="document-notice">{details.acquisition === 'stale' ? 'This is a previously captured description. Check the employer page for updates.' : 'This description may be incomplete. Check the employer page for the full requirements.'}</p>}
          {sections.length > 0 && <div className="segmented mb-6" aria-label="Description view"><button aria-pressed={!full} onClick={() => setFull(false)}>Highlights</button><button aria-pressed={full} onClick={() => setFull(true)}>Full description</button></div>}
          {full || sections.length === 0 ? <section className="detail-section"><h3>Job description</h3><div className="full-description">{details.document}</div></section>
            : sections.map(section => <section className="detail-section" key={section.label}><h3>{section.label}</h3>
              {section.passages.slice(0, 6).map((passage, i) => <p key={`${passage.start}-${i}`}>{passage.text.replace(/^\s*[-•]\s*\n+/, '• ')}</p>)}
            </section>)}
          {sections.length > 0 && <button className="button-secondary full-width" onClick={() => setFull(!full)}>{full ? 'Show highlights' : 'Read full description'}<Icon name="arrow" size={16} /></button>}
        </>}
      <p className="source-footnote">Source: {posting.source || 'Employer'} · Apply directly with the employer.</p>
    </div>
  </section>;
}
