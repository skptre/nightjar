import { useState, useMemo, useCallback, useEffect } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';

type PipelineStatus =
  | 'saved'
  | 'applied'
  | 'oa'
  | 'phone'
  | 'onsite'
  | 'offer'
  | 'rejected'
  | 'ghosted';

const PIPELINE_COLUMNS: { status: PipelineStatus; label: string }[] = [
  { status: 'saved', label: 'Saved' },
  { status: 'applied', label: 'Applied' },
  { status: 'oa', label: 'OA' },
  { status: 'phone', label: 'Phone' },
  { status: 'onsite', label: 'Onsite' },
  { status: 'offer', label: 'Offer' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'ghosted', label: 'Ghosted' },
];

interface PipelineCard {
  id: string;
  company: string;
  title: string;
  location: string;
  url: string;
  status: PipelineStatus | 'skipped';
  applied_at: string | null;
  deadline: string | null;
  notes: string | null;
  app_created_at: string;
  app_updated_at: string;
  eligibility: string | null;
  score: number | null;
  category: string | null;
  term: string | null;
}

interface PipelineQueryRow {
  id: string;
  data: string;
  status: string;
  applied_at: string | null;
  deadline: string | null;
  notes: string | null;
  app_created_at: string;
  app_updated_at: string;
  eligibility: string | null;
  score: number | null;
  category: string | null;
  term: string | null;
}

function parseCard(row: PipelineQueryRow): PipelineCard | null {
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    return {
      id: row.id,
      company: (parsed['company'] as string) ?? '',
      title: (parsed['title'] as string) ?? '',
      location: (parsed['location'] as string) ?? '',
      url: (parsed['url'] as string) ?? '',
      status: row.status as PipelineCard['status'],
      applied_at: row.applied_at,
      deadline: row.deadline,
      notes: row.notes,
      app_created_at: row.app_created_at,
      app_updated_at: row.app_updated_at,
      eligibility: row.eligibility,
      score: row.score,
      category: row.category,
      term: row.term,
    };
  } catch {
    return null;
  }
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function daysInStatus(updatedAt: string): number {
  return daysAgo(updatedAt);
}

const GHOST_WARNING_DAYS = 30;

function stageColor(status: string): string {
  switch (status) {
    case 'saved': return 'bg-nj-accent';
    case 'applied': return 'bg-nj-tier-2';
    case 'oa': return 'bg-nj-cat-swe';
    case 'phone': return 'bg-nj-cat-hw';
    case 'onsite': return 'bg-nj-tier-1';
    case 'offer': return 'bg-nj-eligible';
    case 'rejected': return 'bg-nj-ineligible';
    case 'ghosted': return 'bg-nj-cat-other';
    default: return 'bg-nj-cat-other';
  }
}

export function PipelineView(): React.ReactNode {
  const { db } = useDatabase();
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSkipped, setShowSkipped] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesValue, setNotesValue] = useState('');
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const [cards, setCards] = useState<PipelineCard[]>([]);

  useEffect(() => {
    let cancelled = false;
    void db.query<PipelineQueryRow>(
      `SELECT p.id, p.data, a.status, a.applied_at, a.deadline, a.notes,
              a.created_at as app_created_at, a.updated_at as app_updated_at,
              p.eligibility, p.score, p.category, p.term
       FROM postings_cache p
       INNER JOIN applications a ON p.id = a.posting_id
       WHERE a.status != 'new'
       ORDER BY a.updated_at DESC`,
    ).then((rows) => {
      if (cancelled) return;
      const result: PipelineCard[] = [];
      for (const row of rows) {
        const card = parseCard(row);
        if (card) result.push(card);
      }
      setCards(result);
    });
    return () => { cancelled = true; };
  }, [db, refreshKey]);

  const columnCards = useMemo(() => {
    const map = new Map<string, PipelineCard[]>();
    for (const col of PIPELINE_COLUMNS) {
      map.set(col.status, []);
    }
    map.set('skipped', []);

    for (const card of cards) {
      const list = map.get(card.status);
      if (list) list.push(card);
    }
    return map;
  }, [cards]);

  const handleDragStart = useCallback(
    (e: React.DragEvent, cardId: string): void => {
      e.dataTransfer.setData('text/plain', cardId);
      e.dataTransfer.effectAllowed = 'move';
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, status: string): void => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverColumn(status);
    },
    [],
  );

  const handleDragLeave = useCallback((): void => {
    setDragOverColumn(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, newStatus: string): void => {
      e.preventDefault();
      setDragOverColumn(null);
      const cardId = e.dataTransfer.getData('text/plain');
      if (!cardId) return;

      const card = cards.find((c) => c.id === cardId);
      if (!card || card.status === newStatus) return;

      const now = new Date().toISOString();

      if (newStatus === 'applied' && !card.applied_at) {
        db.run(
          `UPDATE applications SET status = ?, applied_at = ?, updated_at = ? WHERE posting_id = ?`,
          [newStatus, now, now, cardId],
        );
      } else {
        db.run(
          `UPDATE applications SET status = ?, updated_at = ? WHERE posting_id = ?`,
          [newStatus, now, cardId],
        );
      }

      setRefreshKey((k) => k + 1);
    },
    [db, cards],
  );

  const handleStatusChange = useCallback(
    (cardId: string, newStatus: string): void => {
      const card = cards.find((c) => c.id === cardId);
      if (!card || card.status === newStatus) return;

      const now = new Date().toISOString();

      if (newStatus === 'applied' && !card.applied_at) {
        db.run(
          `UPDATE applications SET status = ?, applied_at = ?, updated_at = ? WHERE posting_id = ?`,
          [newStatus, now, now, cardId],
        );
      } else {
        db.run(
          `UPDATE applications SET status = ?, updated_at = ? WHERE posting_id = ?`,
          [newStatus, now, cardId],
        );
      }

      setRefreshKey((k) => k + 1);
    },
    [db, cards],
  );

  const handleToggleExpand = useCallback(
    (cardId: string): void => {
      setExpandedId((prev) => (prev === cardId ? null : cardId));
      setEditingNotes(null);
    },
    [],
  );

  const handleStartEditNotes = useCallback(
    (card: PipelineCard): void => {
      setEditingNotes(card.id);
      setNotesValue(card.notes ?? '');
    },
    [],
  );

  const handleSaveNotes = useCallback(
    (cardId: string): void => {
      const now = new Date().toISOString();
      db.run(
        `UPDATE applications SET notes = ?, updated_at = ? WHERE posting_id = ?`,
        [notesValue || null, now, cardId],
      );
      setEditingNotes(null);
      setRefreshKey((k) => k + 1);
    },
    [db, notesValue],
  );

  const handleCancelNotes = useCallback((): void => {
    setEditingNotes(null);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setExpandedId(null);
        setEditingNotes(null);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const skippedCards = columnCards.get('skipped') ?? [];
  const skippedCount = skippedCards.length;

  const totalPipeline = cards.filter((c) => c.status !== 'skipped').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-nj-text">
            Pipeline
          </h2>
          {totalPipeline > 0 ? (
            <p className="text-xs text-gray-500 dark:text-nj-muted mt-0.5">
              {totalPipeline} posting{totalPipeline !== 1 ? 's' : ''} in pipeline
            </p>
          ) : (
            <p className="text-xs text-gray-500 dark:text-nj-muted mt-0.5">
              Save or apply to postings from the Feed to see them here.
            </p>
          )}
        </div>
        {skippedCount > 0 && (
          <button
            onClick={() => setShowSkipped(!showSkipped)}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-nj-muted dark:hover:text-nj-text"
          >
            {showSkipped ? 'Hide' : 'Show'} {skippedCount} skipped
          </button>
        )}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-4">
        {PIPELINE_COLUMNS.map((col) => {
          const colCards = columnCards.get(col.status) ?? [];
          const isDragOver = dragOverColumn === col.status;

          return (
            <div
              key={col.status}
              className={`flex-shrink-0 w-56 rounded-lg border overflow-hidden transition-colors ${
                isDragOver
                  ? 'border-nj-accent bg-violet-50/50 dark:border-nj-accent dark:bg-nj-accent/5'
                  : 'border-gray-200 dark:border-nj-border bg-gray-50 dark:bg-nj-bg'
              }`}
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.status)}
            >
              <div className={`h-0.5 ${stageColor(col.status)}`} />
              <div className="px-3 py-2 border-b border-gray-200 dark:border-nj-border">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-700 dark:text-nj-text-dim uppercase tracking-wider">
                    {col.label}
                  </span>
                  <span className="text-xs text-gray-400 dark:text-nj-muted tabular-nums">
                    {colCards.length}
                  </span>
                </div>
              </div>

              <div className="p-2 space-y-2 min-h-[80px] max-h-[calc(100vh-220px)] overflow-y-auto">
                {colCards.length === 0 && (
                  <div className="text-xs text-gray-400 dark:text-nj-muted/50 text-center py-4">
                    Empty
                  </div>
                )}
                {colCards.map((card) => (
                  <PipelineCardComponent
                    key={card.id}
                    card={card}
                    expanded={expandedId === card.id}
                    editingNotes={editingNotes === card.id}
                    notesValue={notesValue}
                    onDragStart={handleDragStart}
                    onToggleExpand={handleToggleExpand}
                    onStatusChange={handleStatusChange}
                    onStartEditNotes={handleStartEditNotes}
                    onSaveNotes={handleSaveNotes}
                    onCancelNotes={handleCancelNotes}
                    onNotesChange={setNotesValue}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {showSkipped && skippedCards.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-gray-500 dark:text-nj-muted mb-2">
            Skipped ({skippedCards.length})
          </h3>
          <div className="grid grid-cols-4 gap-2">
            {skippedCards.map((card) => (
              <div
                key={card.id}
                className="p-2 rounded-md border border-gray-200 dark:border-nj-border bg-gray-50 dark:bg-nj-bg opacity-60"
              >
                <p className="text-xs font-medium text-gray-700 dark:text-nj-text truncate">
                  {card.title}
                </p>
                <p className="text-xs text-gray-500 dark:text-nj-text-dim truncate">
                  {card.company}
                </p>
                <button
                  onClick={() => handleStatusChange(card.id, 'saved')}
                  className="mt-1 text-xs text-nj-accent dark:text-nj-accent-bright hover:underline"
                >
                  Restore to Saved
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface PipelineCardProps {
  card: PipelineCard;
  expanded: boolean;
  editingNotes: boolean;
  notesValue: string;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onToggleExpand: (id: string) => void;
  onStatusChange: (id: string, status: string) => void;
  onStartEditNotes: (card: PipelineCard) => void;
  onSaveNotes: (id: string) => void;
  onCancelNotes: () => void;
  onNotesChange: (value: string) => void;
}

function PipelineCardComponent({
  card,
  expanded,
  editingNotes,
  notesValue,
  onDragStart,
  onToggleExpand,
  onStatusChange,
  onStartEditNotes,
  onSaveNotes,
  onCancelNotes,
  onNotesChange,
}: PipelineCardProps): React.ReactNode {
  const days = daysInStatus(card.app_updated_at);
  const isApplied = card.status === 'applied';
  const nearGhost = isApplied && days >= GHOST_WARNING_DAYS;
  const ghostUrgent = isApplied && days >= 40;

  let eligVerdict = 'unclear';
  try {
    const parsed = JSON.parse(card.eligibility ?? '{}') as { verdict?: string };
    eligVerdict = parsed.verdict ?? 'unclear';
  } catch { /* keep default */ }

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, card.id)}
      className={`rounded-md border cursor-grab active:cursor-grabbing transition-colors ${
        nearGhost
          ? ghostUrgent
            ? 'border-red-300 bg-red-50 dark:border-nj-ineligible/30 dark:bg-nj-ineligible/5'
            : 'border-amber-300 bg-amber-50 dark:border-nj-unclear/30 dark:bg-nj-unclear/5'
          : 'border-gray-200 bg-white dark:border-nj-border dark:bg-nj-surface'
      }`}
    >
      <div
        className="p-2"
        onClick={() => onToggleExpand(card.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(card.id); }}
      >
        <p className="text-xs font-medium text-gray-900 dark:text-nj-text leading-tight truncate" title={card.title}>
          {card.title || '—'}
        </p>
        <p className="text-xs text-gray-500 dark:text-nj-text-dim truncate mt-0.5">
          {card.company || '—'}
        </p>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-[10px] text-gray-400 dark:text-nj-muted">
            {card.applied_at ? formatDate(card.applied_at) : formatDate(card.app_updated_at)}
          </span>
          <span
            className={`text-[10px] ${
              ghostUrgent
                ? 'text-red-600 dark:text-nj-ineligible font-medium'
                : nearGhost
                  ? 'text-amber-600 dark:text-nj-unclear'
                  : 'text-gray-400 dark:text-nj-muted'
            }`}
          >
            {days}d
          </span>
        </div>
        {nearGhost && (
          <p className="text-[10px] mt-1 text-amber-600 dark:text-nj-unclear">
            {ghostUrgent ? 'Auto-ghost in ' + String(45 - days) + 'd' : 'No response in ' + String(days) + 'd'}
          </p>
        )}
      </div>

      {expanded && (
        <div className="border-t border-gray-100 dark:border-nj-border p-2 space-y-2">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray-500 dark:text-nj-text-dim">
                {card.location || 'Remote'}
              </span>
              {card.category && (
                <>
                  <span className="text-[10px] text-gray-300 dark:text-nj-muted">&middot;</span>
                  <span className="text-[10px] text-indigo-600 dark:text-nj-accent-bright">
                    {card.category.toUpperCase()}
                  </span>
                </>
              )}
              <span className="text-[10px] text-gray-300 dark:text-nj-muted">&middot;</span>
              <span
                className={`text-[10px] ${
                  eligVerdict === 'eligible'
                    ? 'text-green-600 dark:text-nj-eligible'
                    : eligVerdict === 'ineligible'
                      ? 'text-red-600 dark:text-nj-ineligible'
                      : 'text-yellow-600 dark:text-nj-unclear'
                }`}
              >
                {eligVerdict}
              </span>
            </div>

            <a
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-nj-accent dark:text-nj-accent-bright hover:underline break-all"
              onClick={(e) => e.stopPropagation()}
            >
              Open posting
            </a>
          </div>

          {/* Notes */}
          <div>
            {editingNotes ? (
              <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
                <textarea
                  value={notesValue}
                  onChange={(e) => onNotesChange(e.target.value)}
                  rows={3}
                  className="w-full text-xs p-1.5 border border-gray-200 dark:border-nj-border-bright rounded bg-white dark:bg-nj-surface-2 text-gray-900 dark:text-nj-text resize-none focus:outline-none focus:ring-1 focus:ring-nj-accent"
                  placeholder="Add notes..."
                  autoFocus
                />
                <div className="flex gap-1">
                  <button
                    onClick={() => onSaveNotes(card.id)}
                    className="text-[10px] px-1.5 py-0.5 bg-nj-accent text-white rounded hover:bg-nj-accent-dim"
                  >
                    Save
                  </button>
                  <button
                    onClick={onCancelNotes}
                    className="text-[10px] px-1.5 py-0.5 text-gray-500 hover:text-gray-700 dark:text-nj-text-dim dark:hover:text-nj-text"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div onClick={(e) => e.stopPropagation()}>
                {card.notes ? (
                  <div>
                    <p className="text-[10px] text-gray-600 dark:text-nj-text-dim whitespace-pre-wrap">
                      {card.notes}
                    </p>
                    <button
                      onClick={() => onStartEditNotes(card)}
                      className="text-[10px] text-nj-accent dark:text-nj-accent-bright hover:underline mt-0.5"
                    >
                      Edit notes
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onStartEditNotes(card)}
                    className="text-[10px] text-gray-400 hover:text-gray-600 dark:text-nj-muted dark:hover:text-nj-text"
                  >
                    + Add notes
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Quick status change */}
          <div className="pt-1 border-t border-gray-100 dark:border-nj-border">
            <p className="text-[10px] text-gray-400 dark:text-nj-muted mb-1">Move to:</p>
            <div className="flex flex-wrap gap-1">
              {PIPELINE_COLUMNS.filter((c) => c.status !== card.status).map((col) => (
                <button
                  key={col.status}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStatusChange(card.id, col.status);
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 dark:border-nj-border text-gray-600 dark:text-nj-text-dim hover:bg-gray-100 dark:hover:bg-nj-surface-2"
                >
                  {col.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
