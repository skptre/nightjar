import { useState, useRef, useEffect } from 'react';

export interface EligibilityData {
  verdict: string;
  reasons: string[];
  flags: Array<{ type: string; matched_sentence: string }>;
}

interface EligibilityBadgeProps {
  eligibilityJson: string | null;
}

function parseEligibility(raw: string | null): EligibilityData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EligibilityData;
  } catch {
    return null;
  }
}

function verdictStyles(verdict: string): string {
  if (verdict === 'eligible')
    return 'bg-green-100 text-green-800 dark:bg-nj-eligible-bg dark:text-nj-eligible';
  if (verdict === 'ineligible')
    return 'bg-red-100 text-red-800 dark:bg-nj-ineligible-bg dark:text-nj-ineligible';
  return 'bg-yellow-100 text-yellow-800 dark:bg-nj-unclear-bg dark:text-nj-unclear';
}

export function EligibilityBadge({ eligibilityJson }: EligibilityBadgeProps): React.ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const eligibility = parseEligibility(eligibilityJson);
  const verdict = eligibility?.verdict ?? 'unclear';

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
        className={`px-2 py-0.5 text-xs rounded-full font-medium cursor-pointer transition-opacity hover:opacity-80 ${verdictStyles(verdict)}`}
      >
        {verdict}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-nj-surface-2 border border-gray-200 dark:border-nj-border-bright rounded-lg shadow-lg shadow-black/20 p-3">
          <p className="text-xs font-medium text-gray-700 dark:text-nj-text mb-2">
            Eligibility: <span className={verdict === 'eligible' ? 'text-nj-eligible' : verdict === 'ineligible' ? 'text-nj-ineligible' : 'text-nj-unclear'}>{verdict}</span>
          </p>
          {eligibility && eligibility.reasons.length > 0 ? (
            <ul className="space-y-1">
              {eligibility.reasons.map((reason, i) => (
                <li key={i} className="text-xs text-gray-600 dark:text-nj-text-dim italic">
                  &ldquo;{reason}&rdquo;
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-500 dark:text-nj-muted">
              {eligibilityJson === null
                ? 'Description not yet fetched.'
                : 'No eligibility signals detected in posting description.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
