import type { DomainValue } from '@/classify/role-taxonomy';
import { memo, useState } from 'react';
import { Glyph } from '@/components/Icon';
import { type CategoryValue } from '@/classify/types';
import { previewLines, useJobDetails } from '@/details/useJobDetails';

export interface PostingRowData {
  id: string;
  company: string;
  company_slug: string;
  title: string;
  location: string;
  locations: string[];
  url: string;
  source: string;
  first_seen_at: string;
  closed_at: string | null;
  category: string | null;
  category_tags: CategoryValue[];
  domain_tags?: DomainValue[];
  term: string | null;
  eligibility: string | null;
  score: number | null;
  score_breakdown: string | null;
  compensation: string | null;
  /** Short pay for the list column ("$52/hr"), from the details cache. */
  pay_label?: string | null;
  description_available?: boolean;
  description_text?: string | null;
  description_status?: string | undefined;
  application_status?: string | null;
}

export type PostingAction = 'save' | 'skip' | 'apply' | 'open';

export function isTracked(status: string | null | undefined): boolean {
  return Boolean(status && !['new', 'skipped'].includes(status));
}

export function initial(name: string): string {
  return (name.trim().charAt(0) || '·').toUpperCase();
}

function ageDays(iso: string): number {
  const diff = Date.now() - new Date(iso).getTime();
  return Number.isFinite(diff) ? Math.max(0, Math.floor(diff / 86400000)) : 0;
}

/** "2d", "3w", "4mo". */
export function ageShort(iso: string): string {
  if (!iso) return '';
  const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  if (!Number.isFinite(hours)) return '';
  if (hours < 24) return hours < 1 ? 'now' : `${String(hours)}h`;
  const d = ageDays(iso);
  if (d < 7) return `${String(d)}d`;
  if (d < 60) return `${String(Math.round(d / 7))}w`;
  return `${String(Math.round(d / 30))}mo`;
}

/** "2 days ago", "A week ago". */
export function ageLong(iso: string): string {
  if (!iso) return 'Not listed';
  const d = ageDays(iso);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${String(d)} days ago`;
  const w = Math.round(d / 7);
  if (d < 60) return w === 1 ? 'A week ago' : `${String(w)} weeks ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function cityLabel(posting: PostingRowData): string {
  const all = posting.locations.length ? posting.locations : posting.location ? [posting.location] : [];
  if (!all.length) return 'Not listed';
  const first = all[0]!.split(',')[0]!.trim() || all[0]!;
  return all.length > 1 ? `${first} +${String(all.length - 1)}` : first;
}

export interface BookmarkPop { id: string; on: boolean; n: number }
export function popAnim(pop: BookmarkPop | null, id: string): { bm: string; ring: string } {
  if (!pop || pop.id !== id) return { bm: 'none', ring: 'none' };
  const k = pop.n % 2 ? 'A' : 'B';
  return { bm: `${pop.on ? 'bmPop' : 'bmOff'}${k} 520ms ease both`, ring: pop.on ? `ring${k} 560ms var(--out) both` : 'none' };
}

export function Bookmark({ posting, pop, size = 18, onToggle }: { posting: PostingRowData; pop: BookmarkPop | null; size?: number; onToggle: () => void }): React.ReactNode {
  const saved = isTracked(posting.application_status);
  const anim = popAnim(pop, posting.id);
  return <button type="button" className="bm" onClick={onToggle} aria-pressed={saved}
    aria-label={`${saved ? 'Remove bookmark' : 'Bookmark'}: ${posting.title || 'Untitled role'}`}>
    <span className="ring" aria-hidden="true" style={{ animation: anim.ring }} />
    <svg width={size} height={size} viewBox="0 0 16 16" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
      aria-hidden="true" style={{ animation: anim.bm }}><path d="M4.5 2.5h7a.5.5 0 0 1 .5.5v10.5l-4-2.75-4 2.75V3a.5.5 0 0 1 .5-.5z" /></svg>
  </button>;
}

interface PostingRowProps {
  posting: PostingRowData;
  open: boolean;
  anim: string | null;
  pop: BookmarkPop | null;
  dataToken?: string | number | null;
  onToggle: (id: string) => void;
  onSave: (id: string) => void;
  onApply: (id: string) => void;
  onReadFull: (id: string, row: HTMLElement | null) => void;
}

/** A job row that opens in place to show highlights, with the full posting a click away. */
export const PostingRow = memo(function PostingRow({ posting, open, anim, pop, dataToken, onToggle, onSave, onApply, onReadFull }: PostingRowProps): React.ReactNode {
  // Load the preview the first time the row opens, and keep it while it folds away.
  const [armed, setArmed] = useState(open);
  if (open && !armed) setArmed(true);
  const loaded = useJobDetails(armed ? posting : null, dataToken);
  const lines = previewLines(loaded.highlights, loaded.blocks);
  const title = posting.title || 'Untitled role';
  const settled = loaded.details !== null || loaded.failed;
  return <div role="listitem" className={`jrow ${open ? 'open' : ''}`} data-id={posting.id} data-glide data-noglide={open ? '' : undefined}
    style={anim ? { animation: anim } : undefined}>
    <div className="rz">
      <div className="jrow-line">
        <button type="button" className="jrow-main cols jobs-cols" aria-expanded={open} aria-label={title} onClick={() => onToggle(posting.id)}>
          <span className="jrow-role">
            <span className="mark" aria-hidden="true">{initial(posting.company)}</span>
            <span><span className="jrow-title">{title}</span><span className="jrow-co">{posting.company}</span></span>
          </span>
          <span className="jrow-cell c-loc">{cityLabel(posting)}</span>
          <span className={`jrow-cell c-pay ${posting.pay_label ? 'pay' : 'none'}`}>{posting.pay_label ?? '—'}</span>
          <span className="jrow-cell age">{ageShort(posting.first_seen_at)}</span>
        </button>
        <Bookmark posting={posting} pop={pop} onToggle={() => onSave(posting.id)} />
      </div>
      <div className="exp" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
        <div>
          <div className="jrow-body" data-body aria-hidden={!open} style={{ opacity: open ? 1 : 0 }}>
            {!settled ? <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }} aria-label="Loading highlights" role="status">
              <span className="sk" style={{ width: '92%' }} /><span className="sk" style={{ width: '78%' }} /><span className="sk" style={{ width: '64%' }} />
            </div> : lines.length ? <ul className="hl-list">{lines.map((text, k) => <li key={k} className="hl" style={open
              ? { opacity: 1, transform: 'none', transitionDelay: `${String(110 + k * 55)}ms` }
              : { opacity: 0, transform: 'translateY(10px)', transitionDelay: '0ms' }}>{text}</li>)}</ul>
              : <p className="dsc hl" style={{ margin: 0 }}>The full story is on the company site. You can still save it and apply there.</p>}
            <div className="hl hl-cta" style={open
              ? { opacity: 1, transform: 'none', transitionDelay: `${String(110 + Math.max(lines.length, 1) * 55 + 30)}ms` }
              : { opacity: 0, transform: 'translateY(10px)', transitionDelay: '0ms' }}>
              <button type="button" className="solid" tabIndex={open ? 0 : -1} onClick={() => onApply(posting.id)}>Apply <Glyph name="ext" size={13} className="ext" /></button>
              <button type="button" className="link" tabIndex={open ? 0 : -1} onClick={e => onReadFull(posting.id, e.currentTarget.closest('.jrow'))}>
                <span className="u">Read full description</span><Glyph name="go" size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>;
});
