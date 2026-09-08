import { useEffect, useRef, useState } from 'react';
import type { OutcomeDetails, PipelineStatus } from './types';

interface OutcomeDialogProps {
  company: string;
  title: string;
  status: PipelineStatus;
  busy?: boolean;
  onSubmit: (details: OutcomeDetails) => void;
  onCancel: () => void;
}

function outcomeLabel(status: PipelineStatus): string {
  if (status === 'phone' || status === 'onsite') return 'interview';
  if (status === 'rejected') return 'rejection';
  return status;
}

export function OutcomeDialog({
  company,
  title,
  status,
  busy = false,
  onSubmit,
  onCancel,
}: OutcomeDialogProps): React.ReactNode {
  const [notes, setNotes] = useState('');
  const [rounds, setRounds] = useState('');
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const label = outcomeLabel(status);
  const titleId = 'outcome-dialog-title';

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    notesRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)');
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('keydown', handleKeyDown); previousFocus?.focus({ preventScroll: true }); };
  }, [busy, onCancel]);

  const submitDetails = (): void => {
    const details: OutcomeDetails = {};
    if (notes.trim()) details.notes = notes.trim();
    if (rounds !== '') details.interviewRounds = Number(rounds);
    onSubmit(details);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl dark:border-nj-border dark:bg-nj-surface"
      >
        <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-nj-text">
          Record {label} outcome
        </h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-nj-text-dim">
          {title} at {company}. Details are optional and stay on this device.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="outcome-notes" className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim">
              What happened? (optional)
            </label>
            <textarea
              ref={notesRef}
              id="outcome-notes"
              value={notes}
              maxLength={400}
              rows={3}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="A sentence or two about what happened."
              className="mt-1 w-full resize-none rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900 focus:border-nj-accent focus:outline-none focus:ring-1 focus:ring-nj-accent dark:border-nj-border-bright dark:bg-nj-surface-2 dark:text-nj-text"
            />
            <p className="mt-1 text-right text-xs text-gray-400 dark:text-nj-muted">
              {notes.length}/400
            </p>
          </div>

          <div>
            <label htmlFor="interview-rounds" className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim">
              Interview rounds completed (optional)
            </label>
            <input
              id="interview-rounds"
              type="number"
              min="0"
              max="20"
              step="1"
              value={rounds}
              onChange={(event) => setRounds(event.target.value)}
              className="mt-1 w-28 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-nj-accent focus:outline-none focus:ring-1 focus:ring-nj-accent dark:border-nj-border-bright dark:bg-nj-surface-2 dark:text-nj-text"
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-nj-text-dim dark:hover:bg-nj-surface-2"
          >
            Cancel move
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onSubmit({})}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-nj-border-bright dark:text-nj-text-dim dark:hover:bg-nj-surface-2"
          >
            Skip details
          </button>
          <button
            type="button"
            disabled={busy}
            aria-label={busy ? 'Saving outcome' : 'Save outcome'}
            onClick={submitDetails}
            className="rounded-md bg-nj-accent px-3 py-2 text-sm font-medium text-white hover:bg-nj-accent-dim disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save outcome'}
          </button>
        </div>
      </div>
    </div>
  );
}
