import { useEffect, useMemo, useRef, useState } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useToast } from './Toast';
import { Icon } from './Icon';
import { openExternal } from '@/lib/platform';
import { issueUrl } from '@/support/SupportSection';
import { useWatchlist, toggleWatch } from '@/hooks/useWatchlist';
import { getJobDetails, acquisitionStatus } from '@/details/cache';
import { extractJobDetails } from '@/details/extract';
import { compensationLabel } from '@/details/pay';
import { formatDescription, buildHighlights, pruneHeadings, type DescBlock } from '@/details/format';
import type { JobDetails } from '@/details/types';
import { CATEGORY_OPTIONS } from '@/classify/types';
import type { PostingRowData } from '@/views/Feed/PostingRow';
import type { PostingAction } from '@/views/Feed/PostingRow';

// A pay label is worth a tag only when it resolves to a single amount with a
// known period ("$41/hr", "$95,000–110,000/year"). Anything ambiguous —
// "See pay details", "Pay not listed", "$100K" with no period — shows nothing.
function concretePay(label: string): string | null {
  return /\d/.test(label) && label.includes('/') ? label : null;
}

// Hide a term chip once its season has already passed, so a role first seen in
// early 2026 doesn't keep advertising "Summer 2026" months later.
const SEASON_END: Record<string, number> = { winter: 2, spring: 5, summer: 8, fall: 12 };
function isPastTerm(term: string | null): boolean {
  const match = /^(spring|summer|fall|winter)_(\d{4})$/.exec(term ?? '');
  if (!match) return false;
  const now = new Date();
  const year = Number(match[2]);
  return year < now.getFullYear()
    || (year === now.getFullYear() && SEASON_END[match[1]!]! < now.getMonth() + 1);
}

function DescriptionBlocks({ blocks }: { blocks: DescBlock[] }): React.ReactNode {
  return <>{blocks.map((block, index) => {
    if (block.kind === 'heading') return <h4 key={index} className="desc-h">{block.text}</h4>;
    if (block.kind === 'list') {
      return <ul key={index} className="desc-ul">{(block.items ?? []).map((item, i) => <li key={i}>{item}</li>)}</ul>;
    }
    return <p key={index} className="desc-p">{block.text}</p>;
  })}</>;
}

export function JobDetail({ posting, onClose, onAction }: {
  posting: PostingRowData; onClose: () => void; onAction: (id: string, action: PostingAction) => void;
}): React.ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const watched = useWatchlist();
  const following = watched.some(c => c.slug === posting.company_slug);
  const [documentState, setDocumentState] = useState<{ id: string; details: JobDetails } | null>(null);
  const [showFull, setShowFull] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const immediateDetails = useMemo(() => posting.description_text !== undefined
    ? extractJobDetails(posting.description_text, {
      acquisition: acquisitionStatus(posting.description_status),
      ...(posting.compensation ? { advertisedCompensation: posting.compensation } : {}),
    }) : null, [posting.description_text, posting.description_status, posting.compensation]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [posting.id]);
  useEffect(() => {
    let cancelled = false;
    setShowFull(false);
    setLoadFailed(false);
    if (immediateDetails) return;
    const timeout = setTimeout(() => { if (!cancelled) setLoadFailed(true); }, 10000);
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
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [db, posting.id, posting.compensation, posting.description_text, posting.description_status, toast, immediateDetails]);

  const details = immediateDetails ?? (documentState?.id === posting.id ? documentState.details : null);
  const blocks = useMemo(() => details?.document ? formatDescription(details.document) : [], [details]);
  const highlights = useMemo(() => buildHighlights(blocks), [blocks]);
  const tracked = posting.application_status && !['new', 'skipped'].includes(posting.application_status);
  const payLabel = details ? concretePay(compensationLabel(details.compensation)) : null;
  const roleTags = posting.category_tags.filter(tag => tag !== 'other');
  const showTerm = posting.term && !isPastTerm(posting.term);
  const hasWords = Boolean(details?.document && details.document.trim());
  // When the captured text is flagged incomplete/stale, don't present curated
  // Highlights from questionable content — show the full description as-is.
  const uncertain = details ? ['partial', 'stale', 'unsupported', 'unavailable'].includes(details.acquisition) : false;

  return <section className="job-detail" aria-label={`Details for ${posting.title}`} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
    <div className="detail-topline"><span>OPPORTUNITY DETAILS</span><button className="icon-button" onClick={onClose} aria-label="Close job details"><Icon name="close" /></button></div>
    <div className="detail-body">
      <div className="detail-company"><span className="company-monogram large">{posting.company.slice(0, 2).toUpperCase()}</span>
        <div><p>{posting.company}</p>{posting.closed_at && <span className="muted text-xs">Posting closed</span>}</div>
        {posting.company_slug && <button className="icon-button" aria-label={`${following ? 'Unfollow' : 'Follow'} ${posting.company}`} aria-pressed={following}
          onClick={() => toggleWatch(posting.company_slug, posting.company)}><Icon name={following ? 'check' : 'watch'} /></button>}
      </div>
      <h2 ref={titleRef} tabIndex={-1} className="detail-title outline-none">{posting.title}</h2>
      <p className="detail-location"><Icon name="pin" size={15} />{posting.location || posting.locations.join(' · ') || 'Location not specified'}</p>
      <div className="detail-tags">
        {payLabel && <span className="pay-tag">{payLabel}</span>}
        {roleTags.map(tag => <span key={tag}>{CATEGORY_OPTIONS.find(c => c.value === tag)?.label ?? tag}</span>)}
        {showTerm && <span>{posting.term!.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())}</span>}
      </div>
      <div className="detail-actions"><button className="button-primary" onClick={() => {
        void openExternal(posting.url).then(ok => { if (!ok) toast('If the employer page did not open, allow pop-ups and try again.', 'error'); });
      }}>Apply <Icon name="external" size={15} /></button>
        <button className="button-secondary" disabled={Boolean(tracked)} onClick={() => onAction(posting.id, 'save')}><Icon name={tracked ? 'check' : 'bookmark'} size={16} />{tracked ? 'Saved to tracker' : 'Save'}</button>
      </div>
      <div className="applied-line">{tracked && posting.application_status !== 'saved' ? <span className="muted">In your tracker · {posting.application_status}</span>
        : <><span>Already sent your application?</span><button className="text-button" onClick={() => onAction(posting.id, 'apply')}>Mark applied <Icon name="check" size={14} /></button></>}</div>
      <div className="detail-divider" />
      {!details ? loadFailed ? <p role="status" className="document-notice">Couldn't load this description. You can still read it on the employer page.</p> : <div className="skeleton-block" role="status" aria-label="Loading description" />
        : !hasWords ?
        <div className="description-empty"><Icon name="external" /><h3>The full story is on the company site.</h3><p>A description isn't available here yet. You can still save this role and apply directly.</p></div>
        : uncertain ? <>
          <p className="document-notice">{details.acquisition === 'stale' ? 'This is a previously captured description. Check the employer page for updates.' : 'This description may be incomplete. Check the employer page for the full requirements.'}</p>
          <div className="desc"><DescriptionBlocks blocks={pruneHeadings(blocks)} /></div>
        </> : <>
          <div className="desc">
            {showFull || highlights.blocks.length === 0
              ? <DescriptionBlocks blocks={pruneHeadings(blocks)} />
              : <>
                <DescriptionBlocks blocks={highlights.blocks} />
                {highlights.qualificationsMissing && <p className="desc-note">Qualifications aren't listed here — read the full description below, or check the company site.</p>}
                {highlights.authFlag && <p className="desc-note">{highlights.authFlag}</p>}
              </>}
          </div>
          {!showFull && highlights.blocks.length > 0 && <button className="button-secondary full-width mt-4" onClick={() => setShowFull(true)}>Read full description<Icon name="arrow" size={16} /></button>}
        </>}
      <button className="text-button text-xs mt-6" onClick={() => void openExternal(issueUrl(posting.id)).then(ok => {
        if (!ok) toast('Could not open the report page. Please try again.', 'error');
      })}>Report a problem with this listing</button>
    </div>
  </section>;
}
