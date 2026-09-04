import { useState, useEffect, useCallback } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { isTauri } from '@/lib/platform';
import { isGmailConnected } from './gmail-auth';
import {
  getPendingSuggestions,
  acceptSuggestion,
  dismissSuggestion,
} from './gmail-service';
import { signalTypeLabel, SIGNAL_SUGGESTED_STATUS, type GmailSuggestion } from './types';

export function GmailSuggestionsPanel({
  onStatusChange,
}: {
  onStatusChange?: () => void;
}): React.ReactNode {
  const { db } = useDatabase();
  const [suggestions, setSuggestions] = useState<GmailSuggestion[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void isGmailConnected().then((connected) => {
      if (cancelled || !connected) return;
      void getPendingSuggestions(db).then((rows) => {
        if (cancelled) return;
        setSuggestions(rows);
        setVisible(rows.length > 0);
      });
    });
    return () => { cancelled = true; };
  }, [db]);

  const handleAccept = useCallback(
    async (suggestion: GmailSuggestion) => {
      const newStatus = SIGNAL_SUGGESTED_STATUS[suggestion.signalType];
      await acceptSuggestion(db, suggestion.id, newStatus);
      setSuggestions((prev) => prev.filter((s) => s.id !== suggestion.id));
      onStatusChange?.();
    },
    [db, onStatusChange],
  );

  const handleDismiss = useCallback(
    async (suggestionId: string) => {
      await dismissSuggestion(db, suggestionId);
      setSuggestions((prev) => prev.filter((s) => s.id !== suggestionId));
    },
    [db],
  );

  if (!visible || suggestions.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-nj-text-dim">
          Gmail Suggestions
          <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-nj-accent text-white">
            {suggestions.length}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="text-xs text-gray-400 dark:text-nj-muted hover:text-gray-600 dark:hover:text-nj-text transition-colors"
        >
          Hide
        </button>
      </div>
      {suggestions.map((suggestion) => (
        <SuggestionCard
          key={suggestion.id}
          suggestion={suggestion}
          onAccept={() => void handleAccept(suggestion)}
          onDismiss={() => void handleDismiss(suggestion.id)}
        />
      ))}
    </div>
  );
}

function SuggestionCard({
  suggestion,
  onAccept,
  onDismiss,
}: {
  suggestion: GmailSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
}): React.ReactNode {
  const suggestedStatus = SIGNAL_SUGGESTED_STATUS[suggestion.signalType];
  const signalLabel = signalTypeLabel(suggestion.signalType);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-nj-border bg-white dark:bg-nj-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SignalBadge type={suggestion.signalType} />
            <span className="text-sm font-medium text-gray-900 dark:text-nj-text truncate">
              {suggestion.companyName}
            </span>
          </div>
          <p className="mt-1 text-xs text-gray-500 dark:text-nj-muted truncate">
            {suggestion.subject}
          </p>
          <p className="mt-0.5 text-xs text-gray-400 dark:text-nj-muted">
            from {suggestion.senderDomain} &middot; {formatReceivedAt(suggestion.receivedAt)}
          </p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onAccept}
            className="rounded-md bg-nj-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-nj-accent-bright transition-colors"
            title={`Update to ${suggestedStatus}`}
          >
            {signalLabel}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-gray-300 dark:border-nj-border px-2.5 py-1 text-xs text-gray-600 dark:text-nj-text-dim hover:bg-gray-50 dark:hover:bg-nj-bg transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function SignalBadge({ type }: { type: GmailSuggestion['signalType'] }): React.ReactNode {
  const colors: Record<string, string> = {
    interview: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    offer: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    rejection: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    assessment: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  };

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colors[type] ?? ''}`}>
      {signalTypeLabel(type)}
    </span>
  );
}

function formatReceivedAt(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}
