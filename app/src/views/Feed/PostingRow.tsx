import type { DomainValue } from '@/classify/role-taxonomy';
import { useEffect, type RefObject } from 'react';
import { Icon } from '@/components/Icon';
import { type CategoryValue } from '@/classify/types';

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
  description_available?: boolean;
  description_text?: string | null;
  description_status?: string | undefined;
  application_status?: string | null;
}

export type PostingAction = 'save' | 'skip' | 'apply' | 'open';

interface PostingRowProps {
  posting: PostingRowData;
  selected: boolean;
  rowRef: RefObject<HTMLDivElement | null>;
  onAction: (id: string, action: PostingAction) => void;
  onSelect?: (() => void) | undefined;
}

function formatRelativeDate(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${String(days)}d`;
  return `${String(Math.floor(days / 30))}mo`;
}

export function PostingRow({ posting, selected, rowRef, onAction, onSelect }: PostingRowProps): React.ReactNode {
  const saved = posting.application_status && !['new', 'skipped'].includes(posting.application_status);
  return <div ref={rowRef} role="listitem" className={`job-row ${selected ? 'selected' : ''}`} data-posting-id={posting.id}>
    <span className="company-monogram">{posting.company.slice(0, 2).toUpperCase()}</span>
    <button className="job-row-main" aria-label={posting.title || 'Untitled role'} onClick={onSelect ?? (() => onAction(posting.id, 'open'))} aria-current={selected ? 'true' : undefined}>
      <span className="job-row-title">{posting.title || 'Untitled role'}</span>
      <span className="job-row-meta"><span>{posting.company}</span><span>·</span><span>{posting.location || posting.locations.join(', ') || 'Location not specified'}</span></span>
    </button>
    <div className="job-row-end"><span className="job-age">{formatRelativeDate(posting.first_seen_at)}</span>
      <button className="icon-button row-save" disabled={Boolean(saved)} onClick={() => onAction(posting.id, 'save')} aria-label={saved ? `Saved ${posting.title}` : `Save ${posting.title}`}>
        <Icon name={saved ? 'check' : 'bookmark'} size={16} />
      </button>
    </div>
  </div>;
}

export function UndoToast({
  title,
  onUndo,
  onDismiss,
}: {
  title: string;
  onUndo: () => void;
  onDismiss: () => void;
}): React.ReactNode {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-gray-800 dark:bg-nj-surface-2 dark:border dark:border-nj-border-bright text-white px-4 py-3 rounded-lg shadow-lg dark:shadow-nj-glow">
      <span className="text-sm">Skipped &ldquo;{title}&rdquo;</span>
      <button
        onClick={onUndo}
        className="text-sm font-medium text-nj-accent-bright hover:text-white underline"
      >
        Undo
      </button>
    </div>
  );
}
