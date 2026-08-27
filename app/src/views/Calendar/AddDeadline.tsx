import { useState, useEffect, type ReactNode } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';

interface AddDeadlineProps {
  initialDate: string;
  onSave: () => void;
  onClose: () => void;
}

interface EligiblePosting {
  posting_id: string;
  company: string;
  title: string;
  status: string;
  currentDeadline: string | null;
}

interface EligiblePostingRow {
  posting_id: string;
  data: string;
  status: string;
  deadline: string | null;
}

export function AddDeadline({ initialDate, onSave, onClose }: AddDeadlineProps): ReactNode {
  const { db } = useDatabase();
  const [date, setDate] = useState(initialDate);
  const [note, setNote] = useState('');
  const [selectedPostingId, setSelectedPostingId] = useState<string | null>(null);
  const [postings, setPostings] = useState<EligiblePosting[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void db.query<EligiblePostingRow>(
      `SELECT a.posting_id, p.data, a.status, a.deadline
       FROM applications a
       INNER JOIN postings_cache p ON p.id = a.posting_id
       WHERE a.status IN ('saved', 'applied', 'oa', 'phone', 'onsite')
       ORDER BY a.updated_at DESC`,
    ).then((rows) => {
      if (cancelled) return;
      const result: EligiblePosting[] = [];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data) as Record<string, unknown>;
          result.push({
            posting_id: row.posting_id,
            company: (parsed['company'] as string) ?? '',
            title: (parsed['title'] as string) ?? '',
            status: row.status,
            currentDeadline: row.deadline,
          });
        } catch { /* skip malformed */ }
      }
      setPostings(result);
    });
    return () => { cancelled = true; };
  }, [db]);

  const handleSave = async (): Promise<void> => {
    if (!selectedPostingId || !date) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      await db.run(
        'UPDATE applications SET deadline = ?, updated_at = ? WHERE posting_id = ?',
        [date, now, selectedPostingId],
      );
      if (note.trim()) {
        const existingNotes = await db.queryOne<{ notes: string | null }>(
          'SELECT notes FROM applications WHERE posting_id = ?',
          [selectedPostingId],
        );
        const newNotes = existingNotes?.notes
          ? `${existingNotes.notes}\nDeadline note: ${note.trim()}`
          : `Deadline note: ${note.trim()}`;
        await db.run(
          'UPDATE applications SET notes = ? WHERE posting_id = ?',
          [newNotes, selectedPostingId],
        );
      }
      onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md mx-4 bg-white dark:bg-nj-surface rounded-lg shadow-xl border border-gray-200 dark:border-nj-border">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-nj-border">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-nj-text">Add Deadline</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:text-nj-muted dark:hover:text-nj-text"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-nj-text-dim mb-1">
              Application
            </label>
            {postings.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-nj-muted">
                No saved or applied postings to add deadlines to.
              </p>
            ) : (
              <select
                value={selectedPostingId ?? ''}
                onChange={(e) => setSelectedPostingId(e.target.value || null)}
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface-2 text-gray-900 dark:text-nj-text focus:outline-none focus:ring-1 focus:ring-nj-accent"
              >
                <option value="">Select a posting...</option>
                {postings.map((p) => (
                  <option key={p.posting_id} value={p.posting_id}>
                    {p.company} — {p.title} ({p.status})
                    {p.currentDeadline ? ` [current: ${p.currentDeadline}]` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-nj-text-dim mb-1">
              Deadline Date
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface-2 text-gray-900 dark:text-nj-text focus:outline-none focus:ring-1 focus:ring-nj-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-nj-text-dim mb-1">
              Note <span className="text-gray-400 dark:text-nj-muted">(optional)</span>
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., OA due, final round"
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface-2 text-gray-900 dark:text-nj-text placeholder-gray-400 dark:placeholder-nj-muted focus:outline-none focus:ring-1 focus:ring-nj-accent"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-200 dark:border-nj-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 dark:text-nj-text-dim dark:hover:text-nj-text"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={!selectedPostingId || !date || saving}
            className="px-3 py-1.5 text-sm bg-nj-accent text-white rounded hover:bg-nj-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save Deadline'}
          </button>
        </div>
      </div>
    </div>
  );
}
