import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { CalendarGrid, type CalendarEvent } from './CalendarGrid';
import { DayDetail } from './DayDetail';
import { AddDeadline } from './AddDeadline';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface ApplicationRow {
  posting_id: string;
  data: string;
  status: string;
  applied_at: string | null;
  deadline: string | null;
  next_action: string | null;
  next_action_at: string | null;
}

interface CompanyMetaRow {
  slug: string;
  name: string;
  typical_open: string | null;
}

function extractField(data: string, field: string): string {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return (parsed[field] as string) ?? '';
  } catch {
    return '';
  }
}

function typicalOpenToDates(yearMonth: string): string[] {
  const parts = yearMonth.split('-');
  if (parts.length < 2) return [];
  const year = parseInt(parts[0] ?? '0', 10);
  const month = parseInt(parts[1] ?? '0', 10);
  if (!year || !month) return [];
  return [`${String(year)}-${String(month).padStart(2, '0')}-01`];
}

export function CalendarView(): ReactNode {
  const { db } = useDatabase();
  const { profile } = useProfile();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showAddDeadline, setShowAddDeadline] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [appEvents, setAppEvents] = useState<CalendarEvent[]>([]);
  const [companyEvents, setCompanyEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    void db.query<ApplicationRow>(
      `SELECT a.posting_id, p.data, a.status, a.applied_at, a.deadline,
              a.next_action, a.next_action_at
       FROM applications a
       INNER JOIN postings_cache p ON p.id = a.posting_id
       WHERE a.status != 'new' AND a.status != 'skipped'`,
    ).then((rows) => {
      if (cancelled) return;
      const events: CalendarEvent[] = [];

      for (const row of rows) {
        const company = extractField(row.data, 'company');
        const title = extractField(row.data, 'title');
        const companySlug = extractField(row.data, 'company_slug');

        if (row.deadline) {
          const deadlineDate = row.deadline.slice(0, 10);
          events.push({
            id: `deadline-${row.posting_id}`,
            date: deadlineDate,
            type: 'deadline',
            title: `${company} — ${title}`,
            subtitle: 'Deadline',
            postingId: row.posting_id,
            companySlug,
          });
        }

        if (row.applied_at) {
          const appliedDate = row.applied_at.slice(0, 10);
          events.push({
            id: `applied-${row.posting_id}`,
            date: appliedDate,
            type: 'applied',
            title: `${company} — ${title}`,
            subtitle: `Applied (${row.status})`,
            postingId: row.posting_id,
            companySlug,
          });
        }

        if (row.next_action_at && row.next_action) {
          const actionDate = row.next_action_at.slice(0, 10);
          events.push({
            id: `action-${row.posting_id}`,
            date: actionDate,
            type: 'next_action',
            title: `${company} — ${row.next_action}`,
            subtitle: title,
            postingId: row.posting_id,
            companySlug,
          });
        }
      }

      setAppEvents(events);
    });
    return () => { cancelled = true; };
  }, [db, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    void db.query<CompanyMetaRow>(
      'SELECT slug, name, typical_open FROM companies_meta WHERE typical_open IS NOT NULL',
    ).then((rows) => {
      if (cancelled) return;
      const tieredSlugs = new Set(Object.keys(profile?.tiers ?? {}));
      const events: CalendarEvent[] = [];

      for (const row of rows) {
        if (!tieredSlugs.has(row.slug)) continue;
        if (!row.typical_open) continue;

        const dates = typicalOpenToDates(row.typical_open);
        for (const date of dates) {
          events.push({
            id: `open-${row.slug}-${date}`,
            date,
            type: 'typical_open',
            title: row.name,
            subtitle: `Typically opens around ${row.typical_open}`,
            companySlug: row.slug,
          });
        }
      }

      setCompanyEvents(events);
    });
    return () => { cancelled = true; };
  }, [db, profile?.tiers, refreshKey]);

  const allEvents = useMemo(
    () => [...appEvents, ...companyEvents],
    [appEvents, companyEvents],
  );

  const selectedDayEvents = useMemo(
    () => selectedDate ? allEvents.filter((e) => e.date.slice(0, 10) === selectedDate) : [],
    [allEvents, selectedDate],
  );

  const handlePrevMonth = useCallback((): void => {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
    setSelectedDate(null);
  }, [month]);

  const handleNextMonth = useCallback((): void => {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
    setSelectedDate(null);
  }, [month]);

  const handleToday = useCallback((): void => {
    const today = new Date();
    setYear(today.getFullYear());
    setMonth(today.getMonth());
    setSelectedDate(null);
  }, []);

  const handleAddDeadlineSaved = useCallback((): void => {
    setShowAddDeadline(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const deadlineCount = appEvents.filter((e) => e.type === 'deadline').length;
  const appliedCount = appEvents.filter((e) => e.type === 'applied').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-nj-text">Calendar</h2>
          <p className="text-xs text-gray-500 dark:text-nj-muted mt-0.5">
            {deadlineCount} deadline{deadlineCount !== 1 ? 's' : ''}, {appliedCount} application{appliedCount !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => setShowAddDeadline(true)}
          className="text-sm px-3 py-1.5 bg-nj-accent text-white rounded-md hover:bg-nj-accent-dim transition-colors"
        >
          + Add Deadline
        </button>
      </div>

      {/* Legend */}
      <div className="flex gap-4 mb-3 text-xs text-gray-500 dark:text-nj-text-dim">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-nj-ineligible" /> Deadlines</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-nj-tier-2" /> Applied</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-nj-unclear" /> Next Actions</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-nj-eligible" /> Program Opens</span>
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={handlePrevMonth}
          className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-nj-muted dark:hover:text-nj-text dark:hover:bg-nj-surface-2 transition-colors"
          aria-label="Previous month"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-nj-text">
            {MONTH_NAMES[month]} {year}
          </h3>
          <button
            onClick={handleToday}
            className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-nj-border text-gray-600 dark:text-nj-text-dim hover:bg-gray-100 dark:hover:bg-nj-surface-2 transition-colors"
          >
            Today
          </button>
        </div>
        <button
          onClick={handleNextMonth}
          className="p-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-nj-muted dark:hover:text-nj-text dark:hover:bg-nj-surface-2 transition-colors"
          aria-label="Next month"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Grid + detail layout */}
      <div className={`grid gap-4 ${selectedDate ? 'grid-cols-[1fr_320px]' : 'grid-cols-1'}`}>
        <div className="border border-gray-200 dark:border-nj-border rounded-lg overflow-hidden bg-white dark:bg-nj-surface">
          <CalendarGrid
            year={year}
            month={month}
            events={allEvents}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />
        </div>

        {selectedDate && (
          <DayDetail
            date={selectedDate}
            events={selectedDayEvents}
            onAddDeadline={() => setShowAddDeadline(true)}
            onClose={() => setSelectedDate(null)}
          />
        )}
      </div>

      {/* Empty state */}
      {allEvents.length === 0 && (
        <div className="mt-6 text-center text-sm text-gray-500 dark:text-nj-muted">
          <p>No deadlines set. Add deadlines from saved postings.</p>
          <p className="mt-1 text-xs">
            Tier companies with typical open dates to see program open indicators.
          </p>
        </div>
      )}

      {showAddDeadline && (
        <AddDeadline
          initialDate={selectedDate ?? new Date().toISOString().slice(0, 10)}
          onSave={handleAddDeadlineSaved}
          onClose={() => setShowAddDeadline(false)}
        />
      )}
    </div>
  );
}
