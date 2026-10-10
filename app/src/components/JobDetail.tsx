import { useEffect, useRef } from 'react';
import { useToast } from './Toast';
import { Glyph } from './Icon';
import { openExternal } from '@/lib/platform';
import { issueUrl } from '@/support/SupportSection';
import { useWatchlist, toggleWatch } from '@/hooks/useWatchlist';
import { pruneHeadings, type DescBlock } from '@/details/format';
import { payLong } from '@/details/pay-label';
import { useJobDetails } from '@/details/useJobDetails';
import { ageLong, Bookmark, initial, isTracked, type BookmarkPop, type PostingAction, type PostingRowData } from '@/views/Feed/PostingRow';
import { stageOf } from '@/views/Pipeline/stages';

export function DescriptionBlocks({ blocks }: { blocks: DescBlock[] }): React.ReactNode {
  return <>{blocks.map((block, index) => {
    if (block.kind === 'heading') return <h3 key={index} className="desc-h">{block.text}</h3>;
    if (block.kind === 'list') return <ul key={index} className="desc-ul">{(block.items ?? []).map((item, i) => <li key={i}>{item}</li>)}</ul>;
    return <p key={index} className="desc-p">{block.text}</p>;
  })}</>;
}

/** The full posting, as it reads inside the sheet. */
export function JobDetail({ posting, onAction, dataToken, pop = null, onSave }: {
  posting: PostingRowData; onClose?: () => void; onAction: (id: string, action: PostingAction) => void;
  // Changes when the underlying feed data could have changed (e.g. a sync wrote a new description).
  dataToken?: string | number | null;
  pop?: BookmarkPop | null; onSave?: () => void;
}): React.ReactNode {
  const { toast } = useToast();
  const watched = useWatchlist();
  const following = watched.some(c => c.slug === posting.company_slug);
  const loaded = useJobDetails(posting, dataToken, () => toast('Could not load the description. You can still open the employer page.', 'error'));
  const { details, blocks, highlights } = loaded;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [posting.id]);
  const tracked = isTracked(posting.application_status);
  const hasWords = Boolean(details?.document && details.document.trim());
  // When the captured text is flagged incomplete or stale, say so above it.
  const uncertain = details ? ['partial', 'stale', 'unsupported', 'unavailable'].includes(details.acquisition) : false;
  const locations = posting.locations.length ? posting.locations.join(', ') : posting.location || 'Not listed';
  const pay = (details ? payLong(details.compensation) : null) ?? posting.pay_label ?? 'Not listed';
  const apply = (): void => {
    void openExternal(posting.url).then(ok => { if (!ok) toast('If the employer page did not open, allow pop-ups and try again.', 'error'); });
  };

  return <article aria-label={`Details for ${posting.title}`}>
    <div className="post-co">
      <span className="mark md" aria-hidden="true" style={{ width: 30, height: 30, fontSize: 13 }}>{initial(posting.company)}</span>
      <span>{posting.company}</span>
      {posting.closed_at && <span className="closed-tag">Posting closed</span>}
      {posting.company_slug && <button type="button" className="icb" aria-pressed={following} aria-label={`${following ? 'Unfollow' : 'Follow'} ${posting.company}`}
        onClick={() => toggleWatch(posting.company_slug, posting.company)}>
        <Glyph name={following ? 'check' : 'watch'} size={13} />{following ? 'Watching' : 'Watch'}
      </button>}
    </div>
    <h2 ref={titleRef} tabIndex={-1} className="post-title">{posting.title}</h2>
    <div className="facts">
      <div><span>Location</span><span>{locations}</span></div>
      <div><span>Pay</span><span>{pay}</span></div>
      <div><span>Posted</span><span>{ageLong(posting.first_seen_at)}</span></div>
    </div>
    <div className="post-actions">
      <button type="button" className="solid" onClick={apply}>Apply on {posting.company} <Glyph name="ext" size={13} className="ext" /></button>
      <Bookmark posting={posting} pop={pop} size={20} onToggle={onSave ?? (() => onAction(posting.id, 'save'))} />
    </div>
    <div className="post-applied">{tracked && posting.application_status !== 'saved'
      ? <span>In your tracker · {stageOf(posting.application_status!).label}</span>
      : <><span>Already sent your application?</span>
        <button type="button" className="link" onClick={() => onAction(posting.id, 'apply')}><span className="u">Mark applied</span><Glyph name="check" size={13} /></button></>}
    </div>
    <div className="post-desc">
      {!details ? loaded.failed
        ? <p role="status" className="desc-note">Couldn’t load this description. You can still read it on the employer page.</p>
        : <div role="status" aria-label="Loading description" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 22 }}>
          {['94%', '88%', '72%', '90%', '60%'].map((w, i) => <span key={i} className="sk" style={{ width: w }} />)}
        </div>
        : !hasWords ? <div className="desc-empty"><strong>The full story is on the company site.</strong>
          <p>A description isn’t available here yet. You can still save this role and apply directly.</p></div>
        : <>
          {uncertain && <p className="desc-note">{details.acquisition === 'stale'
            ? 'This is a previously captured description. Check the employer page for updates.'
            : 'This description may be incomplete. Check the employer page for the full requirements.'}</p>}
          {!uncertain && highlights.authFlag && <p className="desc-note">{highlights.authFlag}</p>}
          <DescriptionBlocks blocks={pruneHeadings(blocks)} />
        </>}
    </div>
    <div className="post-foot">
      <button type="button" className="txt" onClick={() => void openExternal(issueUrl(posting.id)).then(ok => {
        if (!ok) toast('Could not open the report page. Please try again.', 'error');
      })} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}><Glyph name="flag" size={13} />Report a problem with this listing</button>
    </div>
  </article>;
}
