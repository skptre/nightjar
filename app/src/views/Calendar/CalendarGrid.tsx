import type { ReactNode } from 'react';

export interface CalendarEvent {
  id: string;
  date: string;
  type: 'deadline' | 'applied' | 'next_action' | 'typical_open';
  title: string;
  subtitle: string;
  postingId?: string;
  companySlug?: string;
}

interface CalendarGridProps {
  year: number;
  month: number;
  events: CalendarEvent[];
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${String(year)}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isToday(dateKey: string): boolean {
  const now = new Date();
  return dateKey === formatDateKey(now.getFullYear(), now.getMonth(), now.getDate());
}

const DOT_COLORS: Record<CalendarEvent['type'], string> = {
  deadline: 'bg-nj-ineligible',
  applied: 'bg-nj-tier-2',
  next_action: 'bg-nj-unclear',
  typical_open: 'bg-nj-eligible',
};

export function CalendarGrid({
  year,
  month,
  events,
  selectedDate,
  onSelectDate,
}: CalendarGridProps): ReactNode {
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);

  const eventsByDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const dateKey = event.date.slice(0, 10);
    const list = eventsByDate.get(dateKey) ?? [];
    list.push(event);
    eventsByDate.set(dateKey, list);
  }

  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const prevMonthDays = getDaysInMonth(prevYear, prevMonth);

  const cells: ReactNode[] = [];

  for (let i = 0; i < firstDay; i++) {
    const day = prevMonthDays - firstDay + 1 + i;
    cells.push(
      <div key={`prev-${String(i)}`} className="p-1.5 min-h-[72px] text-xs text-gray-300 dark:text-nj-muted/40">
        {day}
      </div>,
    );
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = formatDateKey(year, month, day);
    const dayEvents = eventsByDate.get(dateKey) ?? [];
    const today = isToday(dateKey);
    const selected = selectedDate === dateKey;

    const uniqueTypes = [...new Set(dayEvents.map((e) => e.type))];

    cells.push(
      <button
        key={dateKey}
        onClick={() => onSelectDate(dateKey)}
        className={`p-1.5 min-h-[72px] text-left rounded-md transition-colors relative ${
          selected
            ? 'bg-nj-accent/15 ring-1 ring-nj-accent'
            : 'hover:bg-gray-100 dark:hover:bg-nj-surface-2/60'
        }`}
      >
        <span
          className={`text-xs font-medium inline-flex items-center justify-center w-6 h-6 rounded-full ${
            today
              ? 'bg-nj-accent text-white'
              : 'text-gray-700 dark:text-nj-text'
          }`}
        >
          {day}
        </span>
        {uniqueTypes.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {uniqueTypes.map((type) => (
              <span
                key={type}
                className={`w-1.5 h-1.5 rounded-full ${DOT_COLORS[type]}`}
                title={type.replace('_', ' ')}
              />
            ))}
            {dayEvents.length > 2 && (
              <span className="text-[10px] text-gray-400 dark:text-nj-muted leading-none">
                +{dayEvents.length}
              </span>
            )}
          </div>
        )}
      </button>,
    );
  }

  const totalCells = cells.length;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remaining; i++) {
    cells.push(
      <div key={`next-${String(i)}`} className="p-1.5 min-h-[72px] text-xs text-gray-300 dark:text-nj-muted/40">
        {i}
      </div>,
    );
  }

  return (
    <div>
      <div className="grid grid-cols-7 border-b border-gray-200 dark:border-nj-border">
        {DAY_NAMES.map((name) => (
          <div
            key={name}
            className="py-2 text-center text-xs font-semibold text-gray-500 dark:text-nj-muted uppercase tracking-wider"
          >
            {name}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 border-l border-gray-200 dark:border-nj-border">
        {cells.map((cell, i) => (
          <div key={i} className="border-r border-b border-gray-200 dark:border-nj-border">
            {cell}
          </div>
        ))}
      </div>
    </div>
  );
}
