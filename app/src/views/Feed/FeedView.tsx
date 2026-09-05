import { createRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { useSync } from '@/providers/SyncProvider';
import { useKeyboard } from '@/hooks/useKeyboard';
import { useVirtualList } from '@/hooks/useVirtualList';
import { openExternal } from '@/lib/platform';
import { useToast } from '@/components/Toast';
import { PostingRow, UndoToast, type PostingAction, type PostingRowData } from './PostingRow';
import {
  CATEGORY_OPTIONS,
  matchesCategorySelection,
  parseCategoryTags,
  type CategoryOption,
} from '@/classify/types';

interface UndoState {
  postingId: string;
  title: string;
}

interface PostingQueryRow {
  id: string;
  data: string;
  first_seen_at: string;
  closed_at: string | null;
  category: string | null;
  category_tags: string | null;
  term: string | null;
  eligibility: string | null;
  score: number | null;
  score_breakdown: string | null;
  description: string | null;
}

const POSTING_ROW_HEIGHT = 72;

export const CURRENT_JOBS_QUERY = `SELECT p.id, p.data, p.first_seen_at, p.closed_at, p.category, p.category_tags,
              p.term, p.eligibility, p.score, p.score_breakdown, p.description
       FROM postings_cache p
       LEFT JOIN applications a ON p.id = a.posting_id
       WHERE p.closed_at IS NULL
         AND (a.posting_id IS NULL OR a.status != 'skipped')
       ORDER BY p.first_seen_at DESC`;

const RELATED_FIELD_CLUSTERS: readonly (readonly string[])[] = [
  ['swe', 'data-ml', 'quant', 'research', 'hardware', 'ECE'],
  ['hardware', 'mechE', 'ECE', 'aero', 'civil', 'chemE', 'bioE', 'research'],
  ['quant', 'finance', 'accounting', 'consulting', 'operations'],
  ['research', 'design', 'operations', 'supply-chain'],
];

function parsePostingRow(row: PostingQueryRow): PostingRowData | null {
  try {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    return {
      id: row.id,
      company: (parsed['company'] as string) ?? '',
      company_slug: (parsed['company_slug'] as string) ?? '',
      title: (parsed['title'] as string) ?? '',
      location: (parsed['location'] as string) ?? '',
      locations: (parsed['locations'] as string[]) ?? [],
      url: (parsed['url'] as string) ?? '',
      source: (parsed['source'] as string) ?? '',
      first_seen_at: row.first_seen_at ?? (parsed['first_seen_at'] as string) ?? '',
      closed_at: row.closed_at,
      category: row.category,
      category_tags: parseCategoryTags(row.category_tags, row.category),
      term: row.term,
      eligibility: row.eligibility,
      score: row.score,
      score_breakdown: row.score_breakdown,
      compensation: (parsed['compensation'] as string) ?? null,
      description_available: Boolean(row.description),
    };
  } catch {
    return null;
  }
}

export function filterOptionsForProfile(targetCategories: readonly string[]): readonly CategoryOption[] {
  if (targetCategories.length === 0) return CATEGORY_OPTIONS;
  const targets = new Set(targetCategories);
  const related = new Set(targetCategories);
  for (const cluster of RELATED_FIELD_CLUSTERS) {
    if (cluster.some((category) => targets.has(category))) {
      for (const category of cluster) related.add(category);
    }
  }
  return CATEGORY_OPTIONS.filter((option) => related.has(option.value));
}

export function getFeedEmptyState(
  rawPostingCount: number,
  syncStatus: string,
): { title: string; detail: string | null } {
  if (rawPostingCount === 0 && syncStatus === 'error') {
    return {
      title: "Jobs couldn't be updated.",
      detail: 'Check your connection. Nightjar will retry automatically.',
    };
  }
  return { title: 'No jobs match these filters.', detail: null };
}

export function FeedView(): React.ReactNode {
  const { db } = useDatabase();
  const { toast } = useToast();
  const { profile } = useProfile();
  const { clearNewPostingCount, status: syncStatus, lastSyncedAt } = useSync();
  const [viewMode, setViewMode] = useState<'for-you' | 'all'>(() => profile ? 'for-you' : 'all');
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    () => new Set(profile?.target_categories ?? []),
  );
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rawRows, setRawRows] = useState<PostingQueryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    clearNewPostingCount();
  }, [clearNewPostingCount]);

  useEffect(() => {
    let cancelled = false;
    void db.query<PostingQueryRow>(CURRENT_JOBS_QUERY).then((rows) => {
      if (!cancelled) {
        setRawRows(rows);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [db, refreshKey, syncStatus, lastSyncedAt]);

  useEffect(() => {
    if (!filtersOpen) return;
    const closeWhenOutside = (event: PointerEvent): void => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFiltersOpen(false);
    };
    document.addEventListener('pointerdown', closeWhenOutside);
    return () => document.removeEventListener('pointerdown', closeWhenOutside);
  }, [filtersOpen]);

  const postings = useMemo(() => {
    const query = search.trim().toLowerCase();
    const result: PostingRowData[] = [];
    for (const row of rawRows) {
      const posting = parsePostingRow(row);
      if (!posting) continue;
      if (viewMode === 'for-you' && profile && posting.eligibility) {
        try {
          const eligibility = JSON.parse(posting.eligibility) as { verdict?: string };
          if (eligibility.verdict === 'ineligible') continue;
        } catch {
          // Invalid cached eligibility stays visible for manual review.
        }
      }
      if (!matchesCategorySelection(posting.category_tags, posting.category, selectedCategories)) continue;
      if (
        query
        && !posting.title.toLowerCase().includes(query)
        && !posting.company.toLowerCase().includes(query)
      ) continue;
      result.push(posting);
    }
    if (viewMode === 'for-you' && profile) {
      result.sort((left, right) => {
        const scoreDifference = (right.score ?? -1) - (left.score ?? -1);
        if (scoreDifference !== 0) return scoreDifference;
        return right.first_seen_at.localeCompare(left.first_seen_at);
      });
    }
    return result;
  }, [rawRows, search, selectedCategories, viewMode, profile]);

  const postingIds = useMemo(() => postings.map((posting) => posting.id), [postings]);
  const emptyState = getFeedEmptyState(rawRows.length, syncStatus);
  const filterOptions = useMemo(
    () => filterOptionsForProfile(profile?.target_categories ?? []),
    [profile?.target_categories],
  );
  const {
    visibleRange,
    totalHeight,
    offsetTop,
    containerRef: virtualContainerRef,
    scrollToIndex,
  } = useVirtualList({ itemCount: postings.length, itemHeight: POSTING_ROW_HEIGHT });

  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < postings.length) scrollToIndex(selectedIndex);
  }, [selectedIndex, postings.length, scrollToIndex]);

  const resetListPosition = useCallback((): void => {
    setSelectedIndex(0);
    virtualContainerRef.current?.scrollTo(0, 0);
  }, [virtualContainerRef]);

  const toggleCategory = useCallback((category: string): void => {
    setSelectedCategories((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
    resetListPosition();
  }, [resetListPosition]);

  const clearFilters = useCallback((): void => {
    setSelectedCategories(new Set());
    setSearch('');
    resetListPosition();
  }, [resetListPosition]);

  const handleAction = useCallback((id: string, action: PostingAction): void => {
    const posting = postings.find((candidate) => candidate.id === id);
    if (!posting) return;
    const now = new Date().toISOString();

    if (action === 'open') {
      void openExternal(posting.url).then((opened) => {
        if (!opened) toast('Could not open this job link.', 'error');
      });
      return;
    }
    if (action === 'save') {
      void db.run(
        `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
         VALUES (?, 'saved', COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
        [id, id, now, now],
      ).then(() => setRefreshKey((key) => key + 1));
      return;
    }
    if (action === 'apply') {
      void db.run(
        `INSERT OR REPLACE INTO applications (posting_id, status, applied_at, created_at, updated_at)
         VALUES (?, 'applied', ?, COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
        [id, now, id, now, now],
      ).then(() => setRefreshKey((key) => key + 1));
      return;
    }
    void db.run(
      `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
       VALUES (?, 'skipped', COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
      [id, id, now, now],
    ).then(() => {
      setUndoState({ postingId: id, title: posting.title });
      setRefreshKey((key) => key + 1);
    });
  }, [db, postings, toast]);

  const handleUndo = useCallback((): void => {
    if (!undoState) return;
    void db.run('DELETE FROM applications WHERE posting_id = ?', [undoState.postingId])
      .then(() => setRefreshKey((key) => key + 1));
    setUndoState(null);
  }, [db, undoState]);

  const handleEscape = useCallback((): void => {
    if (filtersOpen) {
      setFiltersOpen(false);
      return;
    }
    if (searchFocused) {
      setSearch('');
      setSearchFocused(false);
      searchRef.current?.blur();
    }
  }, [filtersOpen, searchFocused]);

  useKeyboard({
    postingIds,
    selectedIndex,
    onSelectIndex: setSelectedIndex,
    onAction: handleAction,
    onSearchFocus: () => { searchRef.current?.focus(); setSearchFocused(true); },
    onEscape: handleEscape,
    disabled: false,
  });

  const rowRefs = useMemo(
    () => postings.map(() => createRef<HTMLDivElement>()),
    [postings],
  );

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-gray-950">Jobs</h1>
        <p className="mt-1 text-sm text-gray-500">
          {viewMode === 'for-you' ? 'Relevant jobs ranked for your preferences.' : 'All current postings, newest first.'}
        </p>
        {profile && (
          <div className="mt-3 inline-flex rounded-md border border-gray-300 bg-white p-0.5" aria-label="Job view">
            <button
              type="button"
              aria-pressed={viewMode === 'for-you'}
              onClick={() => {
                setViewMode('for-you');
                setSelectedCategories(new Set(profile.target_categories));
                resetListPosition();
              }}
              className={`rounded px-3 py-1.5 text-sm font-medium ${viewMode === 'for-you' ? 'bg-violet-700 text-white' : 'text-gray-600'}`}
            >
              For you
            </button>
            <button
              type="button"
              aria-pressed={viewMode === 'all'}
              onClick={() => {
                setViewMode('all');
                setSelectedCategories(new Set());
                resetListPosition();
              }}
              className={`rounded px-3 py-1.5 text-sm font-medium ${viewMode === 'all' ? 'bg-violet-700 text-white' : 'text-gray-600'}`}
            >
              All jobs
            </button>
          </div>
        )}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(event) => { setSearch(event.target.value); resetListPosition(); }}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          placeholder="Search title or company"
          aria-label="Search jobs"
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
        />

        <div className="relative" ref={filterMenuRef}>
          <button
            type="button"
            aria-expanded={filtersOpen}
            aria-controls="job-filter-menu"
            onClick={() => setFiltersOpen((open) => !open)}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Filters
          </button>
          {filtersOpen && (
            <div id="job-filter-menu" className="absolute right-0 z-30 mt-2 w-80 rounded-lg border border-gray-200 bg-white p-4 shadow-xl">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-900">Fields</p>
                <button type="button" onClick={() => setFiltersOpen(false)} className="text-xs text-gray-500 hover:text-gray-900">
                  Close
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">Choose one or more fields to narrow the list.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {filterOptions.map((option) => {
                  const active = selectedCategories.has(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleCategory(option.value)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium ${active ? 'border-violet-700 bg-violet-700 text-white' : 'border-gray-300 text-gray-600 hover:border-gray-500'}`}
                    >
                      {option.shortLabel}
                    </button>
                  );
                })}
              </div>
              {selectedCategories.size > 0 && (
                <button type="button" onClick={() => setSelectedCategories(new Set())} className="mt-4 text-xs font-medium text-violet-700 hover:text-violet-900">
                  Show all fields
                </button>
              )}
            </div>
          )}
        </div>

        {(selectedCategories.size > 0 || search) && (
          <button type="button" onClick={clearFilters} className="px-2 py-2 text-sm text-gray-500 hover:text-gray-900">
            Reset
          </button>
        )}
      </div>

      {!loaded || (syncStatus === 'syncing' && rawRows.length === 0) ? (
        <div className="rounded-lg border border-gray-200 bg-white px-6 py-16 text-center text-sm text-gray-500">
          Loading jobs...
        </div>
      ) : postings.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white px-6 py-16 text-center">
          <p className="text-sm font-medium text-gray-900">
            {emptyState.title}
          </p>
          {emptyState.detail ? (
            <p className="mt-2 text-sm text-gray-500">{emptyState.detail}</p>
          ) : (selectedCategories.size > 0 || search) && (
            <button type="button" onClick={clearFilters} className="mt-3 text-sm font-medium text-violet-700 hover:text-violet-900">
              Show all jobs
            </button>
          )}
        </div>
      ) : (
        <div ref={virtualContainerRef} role="list" aria-label="Job postings" className="h-[calc(100vh-210px)] min-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-white">
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ transform: `translateY(${String(offsetTop)}px)` }}>
              {postings.slice(visibleRange.start, visibleRange.end).map((posting, offset) => {
                const index = visibleRange.start + offset;
                return (
                  <PostingRow
                    key={posting.id}
                    posting={posting}
                    selected={index === selectedIndex}
                    rowRef={rowRefs[index]!}
                    onAction={handleAction}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {undoState && (
        <UndoToast title={undoState.title} onUndo={handleUndo} onDismiss={() => setUndoState(null)} />
      )}
    </div>
  );
}
