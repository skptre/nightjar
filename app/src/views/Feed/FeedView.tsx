import { useState, useCallback, useRef, useEffect, useMemo, createRef } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { useSync } from '@/providers/SyncProvider';
import { useKeyboard } from '@/hooks/useKeyboard';
import { useVirtualList } from '@/hooks/useVirtualList';
import { PostingRow, UndoToast, type PostingRowData, type PostingAction } from './PostingRow';
import {
  CATEGORY_FILTER_GROUPS,
  CATEGORY_OPTIONS,
  matchesCategorySelection,
  parseCategoryTags,
} from '@/classify/types';

type TermFilter = 'all' | string;
type EligibilityFilter = 'show' | 'hide';
type TierFilter = 'all' | '1' | '2' | '3' | 'untiered';
type AgeFilter = 'all' | 'today' | 'week' | 'month';
type SourceFilter = 'all' | 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'smartrecruiters' | 'simplify' | 'other';

interface Filters {
  term: TermFilter;
  categories: Set<string>;
  eligibility: EligibilityFilter;
  tier: TierFilter;
  age: AgeFilter;
  source: SourceFilter;
}

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
}

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
    };
  } catch {
    return null;
  }
}

const POSTING_ROW_HEIGHT = 72;

function categoryShortLabel(category: string): string {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.shortLabel
    ?? category;
}

function formatRelativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

function getAgeThreshold(age: AgeFilter): string | null {
  if (age === 'all') return null;
  const now = new Date();
  if (age === 'today') {
    now.setHours(0, 0, 0, 0);
  } else if (age === 'week') {
    now.setDate(now.getDate() - 7);
  } else if (age === 'month') {
    now.setDate(now.getDate() - 30);
  }
  return now.toISOString();
}

export function FeedView(): React.ReactNode {
  const { db } = useDatabase();
  const { profile } = useProfile();
  const { clearNewPostingCount, status: syncStatus, lastSyncedAt, lastError } = useSync();

  const [filters, setFilters] = useState<Filters>({
    term: 'all',
    categories: new Set<string>(),
    eligibility: 'show',
    tier: 'all',
    age: 'all',
    source: 'all',
  });

  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [showIneligible, setShowIneligible] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    clearNewPostingCount();
  }, [clearNewPostingCount]);

  const excludedCompanies = useMemo(
    () => new Set(profile?.excluded_companies ?? []),
    [profile?.excluded_companies],
  );

  const [rawRows, setRawRows] = useState<PostingQueryRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    void db.query<PostingQueryRow>(
      `SELECT p.id, p.data, p.first_seen_at, p.closed_at, p.category, p.category_tags, p.term, p.eligibility, p.score, p.score_breakdown
       FROM postings_cache p
       LEFT JOIN applications a ON p.id = a.posting_id
       WHERE (a.posting_id IS NULL OR a.status = 'new')
         AND p.closed_at IS NULL
       ORDER BY CASE WHEN p.score IS NULL THEN 1 ELSE 0 END, p.score DESC`,
    ).then((rows) => {
      if (!cancelled) setRawRows(rows);
    });
    return () => { cancelled = true; };
  }, [db, refreshKey]);

  const postings = useMemo(() => {
    const parsed: PostingRowData[] = [];
    for (const row of rawRows) {
      const p = parsePostingRow(row);
      if (!p) continue;
      if (excludedCompanies.has(p.company_slug)) continue;

      if (filters.term !== 'all' && p.term !== filters.term) continue;
      if (!matchesCategorySelection(p.category_tags, p.category, filters.categories)) continue;
      if (filters.eligibility === 'hide') {
        try {
          const elig = JSON.parse(p.eligibility ?? '{}') as { verdict?: string };
          if (elig.verdict === 'ineligible') continue;
        } catch { /* keep */ }
      }
      if (filters.tier !== 'all' && profile) {
        const companyTier = profile.tiers[p.company_slug];
        if (filters.tier === 'untiered') {
          if (companyTier !== undefined) continue;
        } else {
          if (String(companyTier) !== filters.tier) continue;
        }
      }
      if (filters.age !== 'all') {
        const threshold = getAgeThreshold(filters.age);
        if (threshold && p.first_seen_at < threshold) continue;
      }
      if (filters.source !== 'all' && p.source !== filters.source) continue;

      if (search) {
        const q = search.toLowerCase();
        if (!p.title.toLowerCase().includes(q) && !p.company.toLowerCase().includes(q)) continue;
      }

      parsed.push(p);
    }

    return parsed;
  }, [rawRows, filters, search, excludedCompanies, profile]);

  const eligiblePostings = useMemo(() => {
    return postings.filter((p) => {
      try {
        const elig = JSON.parse(p.eligibility ?? '{}') as { verdict?: string };
        return elig.verdict !== 'ineligible';
      } catch {
        return true;
      }
    });
  }, [postings]);

  const ineligiblePostings = useMemo(() => {
    return postings.filter((p) => {
      try {
        const elig = JSON.parse(p.eligibility ?? '{}') as { verdict?: string };
        return elig.verdict === 'ineligible';
      } catch {
        return false;
      }
    });
  }, [postings]);

  const displayPostings = filters.eligibility === 'hide' ? postings : eligiblePostings;

  const postingIds = useMemo(() => displayPostings.map((p) => p.id), [displayPostings]);

  const {
    visibleRange,
    totalHeight,
    offsetTop,
    containerRef: virtualContainerRef,
    scrollToIndex,
  } = useVirtualList({
    itemCount: displayPostings.length,
    itemHeight: POSTING_ROW_HEIGHT,
  });

  useEffect(() => {
    if (selectedIndex >= 0 && selectedIndex < displayPostings.length) {
      scrollToIndex(selectedIndex);
    }
  }, [selectedIndex, scrollToIndex, displayPostings.length]);

  const handleSelectIndex = useCallback((index: number): void => {
    setSelectedIndex(index);
  }, []);

  const handleAction = useCallback(
    (id: string, action: PostingAction): void => {
      const posting = postings.find((p) => p.id === id);
      if (!posting) return;

      const now = new Date().toISOString();

      switch (action) {
        case 'save': {
          db.run(
            `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
             VALUES (?, 'saved', COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
            [id, id, now, now],
          );
          setRefreshKey((k) => k + 1);
          break;
        }
        case 'skip': {
          db.run(
            `INSERT OR REPLACE INTO applications (posting_id, status, created_at, updated_at)
             VALUES (?, 'skipped', COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
            [id, id, now, now],
          );
          setUndoState({ postingId: id, title: posting.title });
          setRefreshKey((k) => k + 1);
          break;
        }
        case 'apply': {
          db.run(
            `INSERT OR REPLACE INTO applications (posting_id, status, applied_at, created_at, updated_at)
             VALUES (?, 'applied', ?, COALESCE((SELECT created_at FROM applications WHERE posting_id = ?), ?), ?)`,
            [id, now, id, now, now],
          );
          setRefreshKey((k) => k + 1);
          break;
        }
        case 'open': {
          window.open(posting.url, '_blank');
          break;
        }
      }
    },
    [db, postings],
  );

  const handleUndo = useCallback((): void => {
    if (!undoState) return;
    db.run('DELETE FROM applications WHERE posting_id = ?', [undoState.postingId]);
    setUndoState(null);
    setRefreshKey((k) => k + 1);
  }, [db, undoState]);

  const handleUndoDismiss = useCallback((): void => {
    setUndoState(null);
  }, []);

  const handleSearchFocus = useCallback((): void => {
    searchRef.current?.focus();
    setSearchFocused(true);
  }, []);

  const handleEscape = useCallback((): void => {
    if (searchFocused) {
      setSearch('');
      setSearchFocused(false);
      searchRef.current?.blur();
    }
  }, [searchFocused]);

  useKeyboard({
    postingIds,
    selectedIndex,
    onSelectIndex: handleSelectIndex,
    onAction: handleAction,
    onSearchFocus: handleSearchFocus,
    onEscape: handleEscape,
    disabled: false,
  });

  const availableTerms = useMemo(() => {
    const terms = new Set<string>();
    for (const p of postings) {
      if (p.term && p.term !== 'unknown') terms.add(p.term);
    }
    return Array.from(terms).sort();
  }, [postings]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.term !== 'all') count++;
    if (filters.categories.size > 0) count++;
    if (filters.eligibility === 'hide') count++;
    if (filters.tier !== 'all') count++;
    if (filters.age !== 'all') count++;
    if (filters.source !== 'all') count++;
    return count;
  }, [filters]);

  const resetScroll = useCallback((): void => {
    virtualContainerRef.current?.scrollTo(0, 0);
  }, [virtualContainerRef]);

  const updateFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]): void => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setSelectedIndex(0);
    resetScroll();
  }, [resetScroll]);

  const toggleCategory = useCallback((cat: string): void => {
    setFilters((prev) => {
      const next = new Set(prev.categories);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return { ...prev, categories: next };
    });
    setSelectedIndex(0);
    resetScroll();
  }, [resetScroll]);

  const clearFilters = useCallback((): void => {
    setFilters({
      term: 'all',
      categories: new Set<string>(),
      eligibility: 'show',
      tier: 'all',
      age: 'all',
      source: 'all',
    });
    setSearch('');
    setSelectedIndex(0);
    resetScroll();
  }, [resetScroll]);

  const staleMessage = useMemo(() => {
    if (syncStatus === 'error' && lastError) {
      if (lastError === 'Offline') {
        return 'No internet connection. Showing cached data.';
      }
      if (lastError.includes('404')) {
        return 'Feed unavailable. Try again later.';
      }
      if (lastError.toLowerCase().includes('quota')) {
        return 'Storage full. Export data and clear cache.';
      }
      if (lastSyncedAt) {
        const ago = formatRelativeAge(lastSyncedAt);
        return `Sync failed. Using cached data from ${ago}.`;
      }
      return 'Sync failed. Using cached data.';
    }
    if (lastSyncedAt) {
      const ageMs = Date.now() - new Date(lastSyncedAt).getTime();
      if (ageMs > 30 * 60 * 1000) {
        return `Using cached data from ${formatRelativeAge(lastSyncedAt)}.`;
      }
    }
    return null;
  }, [syncStatus, lastError, lastSyncedAt]);

  return (
    <div>
      {/* Stale data indicator */}
      {staleMessage && (
        <div
          className="mb-3 px-3 py-2 text-xs rounded-md bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-700/40"
          data-testid="stale-data-banner"
        >
          {staleMessage}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Search */}
        <div className="relative">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelectedIndex(0); }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search (/)..."
            aria-label="Search postings"
            className="w-48 px-3 py-1.5 text-sm border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface text-gray-900 dark:text-nj-text placeholder-gray-400 dark:placeholder-nj-muted focus:outline-none focus:ring-1 focus:ring-nj-accent"
          />
        </div>

        {/* Term */}
        <select
          value={filters.term}
          onChange={(e) => updateFilter('term', e.target.value)}
          className="px-2 py-1.5 text-xs border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface text-gray-700 dark:text-nj-text-dim"
        >
          <option value="all">All terms</option>
          {availableTerms.map((t) => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>

        {/* Category multi-select */}
        <details className="relative">
          <summary className="cursor-pointer list-none px-2 py-1.5 text-xs border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface text-gray-700 dark:text-nj-text-dim">
            Categories{filters.categories.size > 0 ? ` (${String(filters.categories.size)})` : ''}
          </summary>
          <div className="absolute left-0 z-20 mt-1 w-96 max-w-[80vw] space-y-3 rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-nj-border dark:bg-nj-surface">
            {CATEGORY_FILTER_GROUPS.map((group) => (
              <fieldset key={group.label}>
                <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-nj-muted">
                  {group.label}
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {group.options.map((cat) => (
                    <button
                      key={cat.value}
                      type="button"
                      aria-pressed={filters.categories.has(cat.value)}
                      onClick={() => toggleCategory(cat.value)}
                      className={`px-2 py-1 text-xs rounded-md border transition-colors ${
                        filters.categories.has(cat.value)
                          ? 'border-nj-accent/60 bg-violet-50 text-violet-700 dark:bg-nj-accent/15 dark:text-nj-accent-bright dark:border-nj-accent/50'
                          : 'border-gray-200 dark:border-nj-border text-gray-500 dark:text-nj-text-dim hover:border-gray-300 dark:hover:border-nj-border-bright'
                      }`}
                    >
                      {cat.shortLabel}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </details>

        {/* Eligibility toggle */}
        <button
          onClick={() => updateFilter('eligibility', filters.eligibility === 'show' ? 'hide' : 'show')}
          className={`px-2 py-1 text-xs rounded-md border transition-colors ${
            filters.eligibility === 'hide'
              ? 'border-red-300 bg-red-50 text-red-700 dark:bg-nj-ineligible/10 dark:text-nj-ineligible dark:border-nj-ineligible/30'
              : 'border-gray-200 dark:border-nj-border text-gray-500 dark:text-nj-text-dim'
          }`}
        >
          {filters.eligibility === 'hide' ? 'Ineligible hidden' : 'Show all'}
        </button>

        {/* Tier */}
        <select
          value={filters.tier}
          onChange={(e) => updateFilter('tier', e.target.value as TierFilter)}
          className="px-2 py-1.5 text-xs border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface text-gray-700 dark:text-nj-text-dim"
        >
          <option value="all">All tiers</option>
          <option value="1">Tier 1</option>
          <option value="2">Tier 2</option>
          <option value="3">Tier 3</option>
          <option value="untiered">Untiered</option>
        </select>

        {/* Age */}
        <select
          value={filters.age}
          onChange={(e) => updateFilter('age', e.target.value as AgeFilter)}
          className="px-2 py-1.5 text-xs border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface text-gray-700 dark:text-nj-text-dim"
        >
          <option value="all">Any age</option>
          <option value="today">Today</option>
          <option value="week">This week</option>
          <option value="month">This month</option>
        </select>

        {/* Source */}
        <select
          value={filters.source}
          onChange={(e) => updateFilter('source', e.target.value as SourceFilter)}
          className="px-2 py-1.5 text-xs border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface text-gray-700 dark:text-nj-text-dim"
        >
          <option value="all">All sources</option>
          <option value="greenhouse">Greenhouse</option>
          <option value="lever">Lever</option>
          <option value="ashby">Ashby</option>
          <option value="workday">Workday</option>
          <option value="smartrecruiters">SmartRecruiters</option>
          <option value="simplify">Simplify</option>
          <option value="other">Other</option>
        </select>

        {/* Clear */}
        {(activeFilterCount > 0 || search) && (
          <button
            onClick={clearFilters}
            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Active filter chips */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {filters.term !== 'all' && (
            <FilterChip label={`Term: ${filters.term.replace(/_/g, ' ')}`} onRemove={() => updateFilter('term', 'all')} />
          )}
          {Array.from(filters.categories).map((cat) => (
            <FilterChip key={cat} label={`Category: ${categoryShortLabel(cat)}`} onRemove={() => toggleCategory(cat)} />
          ))}
          {filters.eligibility === 'hide' && (
            <FilterChip label="Hiding ineligible" onRemove={() => updateFilter('eligibility', 'show')} />
          )}
          {filters.tier !== 'all' && (
            <FilterChip label={`Tier: ${filters.tier}`} onRemove={() => updateFilter('tier', 'all')} />
          )}
          {filters.age !== 'all' && (
            <FilterChip label={`Age: ${filters.age}`} onRemove={() => updateFilter('age', 'all')} />
          )}
          {filters.source !== 'all' && (
            <FilterChip label={`Source: ${filters.source}`} onRemove={() => updateFilter('source', 'all')} />
          )}
        </div>
      )}

      {/* Posting count */}
      <div className="text-xs text-gray-500 dark:text-nj-muted mb-2">
        {displayPostings.length} posting{displayPostings.length !== 1 ? 's' : ''}
        {search && ` matching "${search}"`}
      </div>

      {/* Posting list — virtualized */}
      <div className="border border-gray-200 dark:border-nj-border rounded-lg overflow-hidden" role="list" aria-label="Job postings">
        {displayPostings.length === 0 ? (
          <div className="py-16 text-center text-gray-500 dark:text-nj-muted" data-testid="feed-empty-state">
            {syncStatus === 'syncing' && rawRows.length === 0 ? (
              <>
                <svg className="w-8 h-8 mx-auto mb-3 animate-spin text-nj-accent" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-sm font-medium">Syncing feed…</p>
                <p className="text-xs mt-1">First sync may take a moment.</p>
              </>
            ) : activeFilterCount > 0 || search ? (
              <>
                <p className="text-sm">No postings match your filters.</p>
                <button
                  onClick={clearFilters}
                  className="mt-2 text-sm text-nj-accent dark:text-nj-accent-bright hover:underline"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">No postings to triage.</p>
                <p className="text-xs mt-1">All caught up! New postings appear here after each sync.</p>
              </>
            )}
          </div>
        ) : (
          <div
            ref={virtualContainerRef}
            className="overflow-y-auto"
            style={{ maxHeight: `calc(100vh - 280px)` }}
            data-testid="virtual-scroll-container"
          >
            <div style={{ height: totalHeight, position: 'relative' }}>
              <div style={{ position: 'absolute', top: offsetTop, left: 0, right: 0 }}>
                {displayPostings.slice(visibleRange.start, visibleRange.end).map((posting, idx) => (
                  <div
                    key={posting.id}
                    style={{ height: POSTING_ROW_HEIGHT }}
                  >
                    <PostingRow
                      posting={posting}
                      selected={visibleRange.start + idx === selectedIndex}
                      rowRef={createRef()}
                      onAction={handleAction}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Ineligible section — collapsed at bottom */}
      {filters.eligibility !== 'hide' && ineligiblePostings.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowIneligible(!showIneligible)}
            className="flex items-center gap-2 text-sm text-gray-500 dark:text-nj-muted hover:text-gray-700 dark:hover:text-nj-text"
          >
            <span className="text-xs">{showIneligible ? '▼' : '▶'}</span>
            {ineligiblePostings.length} ineligible posting{ineligiblePostings.length !== 1 ? 's' : ''}
          </button>
          {showIneligible && (
            <div className="mt-2 border border-gray-200 dark:border-nj-border rounded-lg overflow-hidden opacity-60">
              {ineligiblePostings.map((posting) => (
                <PostingRow
                  key={posting.id}
                  posting={posting}
                  selected={false}
                  rowRef={createRef()}
                  onAction={handleAction}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Undo toast */}
      {undoState && (
        <UndoToast
          title={undoState.title}
          onUndo={handleUndo}
          onDismiss={handleUndoDismiss}
        />
      )}

      {/* Keyboard hint */}
      <div className="mt-4 text-xs text-gray-400 dark:text-nj-muted/50 text-center">
        <kbd className="px-1 py-0.5 bg-gray-100 dark:bg-nj-surface-2 rounded text-[10px]">j</kbd>/<kbd className="px-1 py-0.5 bg-gray-100 dark:bg-nj-surface-2 rounded text-[10px]">k</kbd> navigate
        {' '}<kbd className="px-1 py-0.5 bg-gray-100 dark:bg-nj-surface-2 rounded text-[10px]">s</kbd> save
        {' '}<kbd className="px-1 py-0.5 bg-gray-100 dark:bg-nj-surface-2 rounded text-[10px]">x</kbd> skip
        {' '}<kbd className="px-1 py-0.5 bg-gray-100 dark:bg-nj-surface-2 rounded text-[10px]">o</kbd> open
        {' '}<kbd className="px-1 py-0.5 bg-gray-100 dark:bg-nj-surface-2 rounded text-[10px]">a</kbd> apply
        {' '}<kbd className="px-1 py-0.5 bg-gray-100 dark:bg-nj-surface-2 rounded text-[10px]">/</kbd> search
      </div>
    </div>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-violet-50 text-violet-700 dark:bg-nj-accent/15 dark:text-nj-accent-bright">
      {label}
      <button
        onClick={onRemove}
        className="text-violet-400 hover:text-violet-600 dark:text-nj-accent-bright/60 dark:hover:text-nj-accent-bright"
        aria-label={`Remove filter: ${label}`}
      >
        &times;
      </button>
    </span>
  );
}
