import { useState, useRef, useEffect } from 'react';

interface Breakdown {
  tier: number;
  freshness: number;
  category: number;
  eligibility: number;
}

interface ScoreBreakdownProps {
  score: number;
  breakdownJson: string | null;
}

function parseBreakdown(raw: string | null): Breakdown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Breakdown;
  } catch {
    return null;
  }
}

function scoreColor(score: number): string {
  if (score > 70) return 'text-green-600 dark:text-nj-score-high';
  if (score >= 40) return 'text-yellow-600 dark:text-nj-score-mid';
  return 'text-red-600 dark:text-nj-score-low';
}

function scoreBgColor(score: number): string {
  if (score > 70) return 'bg-green-50 dark:bg-nj-eligible-bg';
  if (score >= 40) return 'bg-yellow-50 dark:bg-nj-unclear-bg';
  return 'bg-red-50 dark:bg-nj-ineligible-bg';
}

export function ScoreBreakdown({ score, breakdownJson }: ScoreBreakdownProps): React.ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const breakdown = parseBreakdown(breakdownJson);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`w-10 text-center py-0.5 text-xs font-bold rounded cursor-pointer transition-opacity hover:opacity-80 ${scoreBgColor(score)} ${scoreColor(score)}`}
      >
        {Math.round(score)}
      </button>
      {open && breakdown && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-white dark:bg-nj-surface-2 border border-gray-200 dark:border-nj-border-bright rounded-lg shadow-lg shadow-black/20 p-3">
          <p className="text-xs font-medium text-gray-700 dark:text-nj-text mb-2">Score breakdown</p>
          <table className="w-full text-xs">
            <tbody>
              <tr>
                <td className="text-gray-500 dark:text-nj-muted py-0.5">Tier</td>
                <td className="text-right font-medium text-gray-700 dark:text-nj-text">+{breakdown.tier}</td>
              </tr>
              <tr>
                <td className="text-gray-500 dark:text-nj-muted py-0.5">Freshness</td>
                <td className="text-right font-medium text-gray-700 dark:text-nj-text">+{Math.round(breakdown.freshness)}</td>
              </tr>
              <tr>
                <td className="text-gray-500 dark:text-nj-muted py-0.5">Category</td>
                <td className="text-right font-medium text-gray-700 dark:text-nj-text">+{breakdown.category}</td>
              </tr>
              <tr>
                <td className="text-gray-500 dark:text-nj-muted py-0.5">Eligibility</td>
                <td className="text-right font-medium text-gray-700 dark:text-nj-text">+{breakdown.eligibility}</td>
              </tr>
              <tr className="border-t border-gray-200 dark:border-nj-border-bright">
                <td className="text-gray-700 dark:text-nj-text pt-1 font-medium">Total</td>
                <td className={`text-right pt-1 font-bold ${scoreColor(score)}`}>
                  {Math.round(score)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
