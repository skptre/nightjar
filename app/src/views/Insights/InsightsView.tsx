import { useEffect, useState } from 'react';
import { recomputeAll } from '@/classify/recompute';
import {
  analyzeOutcomeHistory,
  applySuggestionToProfile,
  loadOutcomeRecords,
  type BreakdownRow,
  type OutcomeAnalysis,
  type RecalibrationSuggestion,
} from '@/engine/recalibrate';
import { loadSuggestionDecisions, saveSuggestionDecision } from '@/outcomes/outcome-service';
import type { SuggestionDecision } from '@/outcomes/types';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';

interface InsightsDashboardProps {
  analysis: OutcomeAnalysis;
  decisions: Record<string, SuggestionDecision>;
  onApply: (suggestion: RecalibrationSuggestion) => void;
  onDismiss: (suggestionId: string) => void;
}

function formatPercent(value: number): string {
  return `${String(value)}%`;
}

function StatsCard({ label, value }: { label: string; value: string | number }): React.ReactNode {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-nj-border dark:bg-nj-surface">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-nj-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-nj-text">{value}</p>
    </div>
  );
}

function BreakdownTable({ label, rows }: { label: string; rows: BreakdownRow[] }): React.ReactNode {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-nj-border">
      <table aria-label={label} className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-nj-surface-2 dark:text-nj-muted">
          <tr>
            <th scope="col" className="px-3 py-2">Group</th>
            <th scope="col" className="px-3 py-2 text-right">Applied</th>
            <th scope="col" className="px-3 py-2 text-right">Interviewed</th>
            <th scope="col" className="px-3 py-2 text-right">Offered</th>
            <th scope="col" className="px-3 py-2 text-right">Ghosted</th>
            <th scope="col" className="px-3 py-2 text-right">Interview rate</th>
            <th scope="col" className="px-3 py-2 text-right">Ghost rate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-nj-border dark:bg-nj-surface">
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="px-3 py-2 font-medium text-gray-800 dark:text-nj-text">{row.label}</th>
              <td className="px-3 py-2 text-right tabular-nums">{row.applied}</td>
              <td className="px-3 py-2 text-right tabular-nums">{row.interviewed}</td>
              <td className="px-3 py-2 text-right tabular-nums">{row.offered}</td>
              <td className="px-3 py-2 text-right tabular-nums">{row.ghosted}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.interviewRate)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatPercent(row.ghostRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Timeline({ analysis }: { analysis: OutcomeAnalysis }): React.ReactNode {
  const max = Math.max(1, ...analysis.stats.timeline.flatMap((point) => [point.applications, point.interviews]));
  return (
    <div
      role="img"
      aria-label="Applications and interviews by week"
      className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-nj-border dark:bg-nj-surface"
    >
      {analysis.stats.timeline.map((point) => (
        <div key={point.weekStart} className="grid grid-cols-[6rem_1fr] items-center gap-3">
          <span className="text-xs text-gray-500 dark:text-nj-muted">{point.weekStart}</span>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="h-2 rounded bg-nj-accent" style={{ width: `${String((point.applications / max) * 100)}%` }} />
              <span className="text-xs text-gray-500 dark:text-nj-text-dim">{point.applications} applications</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 rounded bg-nj-eligible" style={{ width: `${String((point.interviews / max) * 100)}%` }} />
              <span className="text-xs text-gray-500 dark:text-nj-text-dim">{point.interviews} interviews</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function InsightsDashboard({
  analysis,
  decisions,
  onApply,
  onDismiss,
}: InsightsDashboardProps): React.ReactNode {
  const { stats } = analysis;
  return (
    <div className="space-y-6">
      <section aria-labelledby="insights-summary">
        <h2 id="insights-summary" className="text-lg font-semibold text-gray-900 dark:text-nj-text">Outcome insights</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-nj-text-dim">{analysis.message}</p>
      </section>

      <section aria-label="Application statistics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatsCard label="Applications sent" value={stats.applicationsSent} />
        <StatsCard label="Interview rate" value={formatPercent(stats.interviewRate)} />
        <StatsCard label="Offer rate" value={formatPercent(stats.offerRate)} />
        <StatsCard label="Interviews" value={stats.interviewed} />
        <StatsCard label="Average response" value={stats.averageResponseDays === null ? '—' : `${String(stats.averageResponseDays)} days`} />
      </section>

      {analysis.ready && (
        <section aria-labelledby="suggestions-heading" className="space-y-3">
          <h3 id="suggestions-heading" className="text-base font-semibold text-gray-900 dark:text-nj-text">Suggested adjustments</h3>
          {analysis.suggestions.length === 0 ? (
            <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-nj-border dark:bg-nj-surface dark:text-nj-text-dim">
              No strong scoring adjustment stands out yet. Keep recording outcomes and the patterns will update.
            </p>
          ) : analysis.suggestions.map((suggestion) => {
            const decision = decisions[suggestion.id];
            return (
              <article key={suggestion.id} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-nj-border dark:bg-nj-surface">
                <p className="text-sm text-gray-700 dark:text-nj-text-dim">{suggestion.message}</p>
                {decision ? (
                  <p className="mt-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-nj-muted">
                    {decision === 'applied' ? 'Applied' : 'Dismissed'}
                  </p>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      aria-label="Apply suggestion"
                      onClick={() => onApply(suggestion)}
                      className="rounded-md bg-nj-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-nj-accent-dim"
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      aria-label="Dismiss suggestion"
                      onClick={() => onDismiss(suggestion.id)}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-nj-border-bright dark:text-nj-text-dim dark:hover:bg-nj-surface-2"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {analysis.observations.length > 0 && (
        <section aria-labelledby="observations-heading" className="space-y-2">
          <h3 id="observations-heading" className="text-base font-semibold text-gray-900 dark:text-nj-text">Other patterns</h3>
          <ul className="space-y-2">
            {analysis.observations.map((observation) => (
              <li key={observation} className="rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600 dark:border-nj-border dark:bg-nj-surface dark:text-nj-text-dim">
                {observation}
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats.timeline.length > 0 && (
        <section aria-labelledby="timeline-heading" className="space-y-2">
          <h3 id="timeline-heading" className="text-base font-semibold text-gray-900 dark:text-nj-text">Weekly activity</h3>
          <Timeline analysis={analysis} />
        </section>
      )}

      {stats.byCategory.length > 0 && (
        <section aria-labelledby="category-heading" className="space-y-2">
          <h3 id="category-heading" className="text-base font-semibold text-gray-900 dark:text-nj-text">By category</h3>
          <BreakdownTable label="Outcomes by category" rows={stats.byCategory} />
        </section>
      )}

      {stats.byTier.length > 0 && (
        <section aria-labelledby="tier-heading" className="space-y-2">
          <h3 id="tier-heading" className="text-base font-semibold text-gray-900 dark:text-nj-text">By tier</h3>
          <BreakdownTable label="Outcomes by tier" rows={stats.byTier} />
        </section>
      )}
    </div>
  );
}

export function InsightsView(): React.ReactNode {
  const { db } = useDatabase();
  const { profile, updateProfile } = useProfile();
  const [analysis, setAnalysis] = useState<OutcomeAnalysis | null>(null);
  const [decisions, setDecisions] = useState<Record<string, SuggestionDecision>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    Promise.all([loadOutcomeRecords(db, profile), loadSuggestionDecisions(db)])
      .then(([records, storedDecisions]) => {
        if (cancelled) return;
        setAnalysis(analyzeOutcomeHistory(records));
        setDecisions(storedDecisions);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => { cancelled = true; };
  }, [db, profile]);

  if (!profile) return null;
  if (error) return <p role="alert" className="text-sm text-nj-ineligible">Unable to load outcome insights: {error}</p>;
  if (!analysis) return <p className="text-sm text-gray-500 dark:text-nj-muted">Calculating local outcome patterns…</p>;

  const applySuggestion = (suggestion: RecalibrationSuggestion): void => {
    const updated = applySuggestionToProfile(profile, suggestion);
    updateProfile(updated);
    void recomputeAll(db, updated)
      .then(() => saveSuggestionDecision(db, suggestion.id, 'applied'))
      .then(() => setDecisions((current) => ({ ...current, [suggestion.id]: 'applied' })))
      .catch((reason: unknown) => setError(String(reason)));
  };

  const dismissSuggestion = (suggestionId: string): void => {
    void saveSuggestionDecision(db, suggestionId, 'dismissed')
      .then(() => setDecisions((current) => ({ ...current, [suggestionId]: 'dismissed' })))
      .catch((reason: unknown) => setError(String(reason)));
  };

  return (
    <InsightsDashboard
      analysis={analysis}
      decisions={decisions}
      onApply={applySuggestion}
      onDismiss={dismissSuggestion}
    />
  );
}
