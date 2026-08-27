import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CalendarEvent } from './CalendarGrid';

interface DayDetailProps {
  date: string;
  events: CalendarEvent[];
  onAddDeadline: () => void;
  onClose: () => void;
}

const TYPE_LABELS: Record<CalendarEvent['type'], string> = {
  deadline: 'Deadlines',
  applied: 'Applied',
  next_action: 'Next Actions',
  typical_open: 'Program Opens',
};

const TYPE_COLORS: Record<CalendarEvent['type'], string> = {
  deadline: 'text-nj-ineligible',
  applied: 'text-nj-tier-2',
  next_action: 'text-nj-unclear',
  typical_open: 'text-nj-eligible',
};

const TYPE_DOT_COLORS: Record<CalendarEvent['type'], string> = {
  deadline: 'bg-nj-ineligible',
  applied: 'bg-nj-tier-2',
  next_action: 'bg-nj-unclear',
  typical_open: 'bg-nj-eligible',
};

function formatDisplayDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function DayDetail({ date, events, onAddDeadline, onClose }: DayDetailProps): ReactNode {
  const navigate = useNavigate();

  const grouped = new Map<CalendarEvent['type'], CalendarEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.type) ?? [];
    list.push(event);
    grouped.set(event.type, list);
  }

  const typeOrder: CalendarEvent['type'][] = ['deadline', 'next_action', 'applied', 'typical_open'];

  const handleEventClick = (event: CalendarEvent): void => {
    if (event.companySlug) {
      void navigate(`/companies/${event.companySlug}`);
    }
  };

  return (
    <div className="border border-gray-200 dark:border-nj-border rounded-lg bg-white dark:bg-nj-surface overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-nj-border">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-nj-text">
            {formatDisplayDate(date)}
          </h3>
          <p className="text-xs text-gray-500 dark:text-nj-muted mt-0.5">
            {events.length} event{events.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onAddDeadline}
            className="text-xs px-2.5 py-1 bg-nj-accent text-white rounded hover:bg-nj-accent-dim transition-colors"
          >
            + Deadline
          </button>
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
      </div>

      <div className="max-h-[400px] overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-nj-muted">
            No events on this date.
            <button
              onClick={onAddDeadline}
              className="block mx-auto mt-2 text-nj-accent dark:text-nj-accent-bright hover:underline text-xs"
            >
              Add a deadline
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-nj-border">
            {typeOrder.map((type) => {
              const group = grouped.get(type);
              if (!group || group.length === 0) return null;

              return (
                <div key={type} className="px-4 py-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className={`w-2 h-2 rounded-full ${TYPE_DOT_COLORS[type]}`} />
                    <span className={`text-xs font-semibold uppercase tracking-wider ${TYPE_COLORS[type]}`}>
                      {TYPE_LABELS[type]}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {group.map((event) => (
                      <button
                        key={event.id}
                        onClick={() => handleEventClick(event)}
                        className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-nj-surface-2/50 transition-colors"
                      >
                        <p className="text-sm text-gray-900 dark:text-nj-text truncate">
                          {event.title}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-nj-text-dim truncate">
                          {event.subtitle}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
