import { useEffect, type RefObject } from 'react';
import { EligibilityBadge } from '@/components/EligibilityBadge';
import { ScoreBreakdown } from '@/components/ScoreBreakdown';
import { CATEGORY_OPTIONS, type CategoryValue } from '@/classify/types';

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
  term: string | null;
  eligibility: string | null;
  score: number | null;
  score_breakdown: string | null;
  compensation: string | null;
}

export type PostingAction = 'save' | 'skip' | 'apply' | 'open';

interface PostingRowProps {
  posting: PostingRowData;
  selected: boolean;
  rowRef: RefObject<HTMLDivElement | null>;
  onAction: (id: string, action: PostingAction) => void;
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

function termLabel(term: string | null): string | null {
  if (!term || term === 'unknown') return null;
  return term.replace(/_/g, ' ');
}

function categoryLabel(cat: string | null): string | null {
  if (!cat) return null;
  return CATEGORY_OPTIONS.find((option) => option.value === cat)?.shortLabel ?? cat;
}

function categoryTagStyle(cat: string | null): string {
  switch (cat) {
    case 'swe': return 'bg-cyan-50 text-cyan-700 dark:bg-nj-cat-swe/10 dark:text-nj-cat-swe';
    case 'quant': return 'bg-orange-50 text-orange-700 dark:bg-nj-cat-quant/10 dark:text-nj-cat-quant';
    case 'data-ml': return 'bg-purple-50 text-purple-700 dark:bg-nj-cat-ml/10 dark:text-nj-cat-ml';
    case 'hardware': return 'bg-teal-50 text-teal-700 dark:bg-nj-cat-hw/10 dark:text-nj-cat-hw';
    default: return 'bg-gray-100 text-gray-600 dark:bg-nj-cat-other/10 dark:text-nj-cat-other';
  }
}

export function PostingRow({ posting, selected, rowRef, onAction }: PostingRowProps): React.ReactNode {
  const score = posting.score ?? 0;
  const term = termLabel(posting.term);
  const category = categoryLabel(posting.category);

  return (
    <div
      ref={rowRef}
      role="listitem"
      aria-selected={selected}
      className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-nj-border transition-colors ${
        selected
          ? 'border-l-2 border-l-nj-accent bg-violet-50/50 dark:bg-nj-accent/5'
          : 'border-l-2 border-l-transparent hover:bg-gray-50 dark:hover:bg-nj-surface-2/60'
      }`}
      data-posting-id={posting.id}
    >
      {/* Company + Title */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-nj-text truncate" title={posting.title}>
            {posting.title || '—'}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-gray-600 dark:text-nj-text-dim">{posting.company || '—'}</span>
          <span className="text-xs text-gray-400 dark:text-nj-muted">·</span>
          <span className="text-xs text-gray-500 dark:text-nj-muted truncate" title={posting.location || 'Remote'}>
            {posting.location || 'Remote'}
          </span>
          {posting.compensation && (
            <>
              <span className="text-xs text-gray-400 dark:text-nj-muted">·</span>
              <span className="text-xs text-green-600 dark:text-nj-eligible">{posting.compensation}</span>
            </>
          )}
        </div>
      </div>

      {/* Tags */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {term && (
          <span className="px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-600 dark:bg-nj-surface-2 dark:text-nj-text-dim">
            {term}
          </span>
        )}
        {category && (
          <span className={`px-1.5 py-0.5 text-xs rounded ${categoryTagStyle(posting.category)}`}>
            {category}
          </span>
        )}
      </div>

      {/* Age */}
      <span className="text-xs text-gray-400 dark:text-nj-muted w-8 text-right flex-shrink-0">
        {formatRelativeDate(posting.first_seen_at)}
      </span>

      <EligibilityBadge eligibilityJson={posting.eligibility} />
      <ScoreBreakdown score={score} breakdownJson={posting.score_breakdown} />

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <ActionButton label="Save" shortcut="s" onClick={() => onAction(posting.id, 'save')} />
        <ActionButton label="Skip" shortcut="x" onClick={() => onAction(posting.id, 'skip')} />
        <ActionButton label="Open" shortcut="o" onClick={() => onAction(posting.id, 'open')} />
        <ActionButton label="Apply" shortcut="a" onClick={() => onAction(posting.id, 'apply')} />
      </div>
    </div>
  );
}

function ActionButton({
  label,
  shortcut,
  onClick,
}: {
  label: string;
  shortcut: string;
  onClick: () => void;
}): React.ReactNode {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800 dark:text-nj-muted dark:hover:text-nj-text hover:bg-gray-100 dark:hover:bg-nj-surface-2 rounded transition-colors"
      title={`${label} (${shortcut})`}
      aria-label={`${label} (keyboard: ${shortcut})`}
    >
      {label}
    </button>
  );
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
