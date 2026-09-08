import { JobDetail } from '@/components/JobDetail';
import { Icon } from '@/components/Icon';
import { saveJob, markJobApplied } from './job-actions';
import { recomputeGuestCategories } from '@/classify/guest-classification';
import { DOMAIN_OPTIONS, matchesRoleSelection, parseRoleDomains } from '@/classify/role-taxonomy';
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
  role_classification?: string | null;
  term: string | null;
  eligibility: string | null;
  score: number | null;
  score_breakdown: string | null;
  description: string | null;
  application_status: string | null;
}

const POSTING_ROW_HEIGHT = 72;

export const CURRENT_JOBS_QUERY = `SELECT p.id, p.data, p.first_seen_at, p.closed_at, p.category, p.category_tags, p.role_classification,
              p.term, p.eligibility, p.score, p.score_breakdown, p.description, a.status AS application_status
       FROM postings_cache p
       LEFT JOIN applications a ON p.id = a.posting_id
       WHERE p.closed_at IS NULL
         AND p.id NOT LIKE 'local-%'
         AND (a.posting_id IS NULL OR a.status != 'skipped')
       ORDER BY p.first_seen_at DESC`;

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
      domain_tags: parseRoleDomains(row.role_classification),
      term: row.term,
      eligibility: row.eligibility,
      score: row.score,
      score_breakdown: row.score_breakdown,
      compensation: (parsed['compensation'] as string) ?? null,
      description_available: Boolean(row.description),
      description_text: row.description,
      description_status: typeof parsed['description_status'] === 'string' ? parsed['description_status'] : undefined,
      application_status: row.application_status,
    };
  } catch {
    return null;
  }
}

export function filterOptionsForProfile(_targetCategories: readonly string[]): readonly CategoryOption[] {
  return CATEGORY_OPTIONS;
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
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [companyFilter, setCompanyFilter] = useState(() => new URLSearchParams(window.location.search).get('company'));
  const [searchFocused, setSearchFocused] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [undoState, setUndoState] = useState<UndoState | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rawRows, setRawRows] = useState<PostingQueryRow[]>([]);
  const currentRows = useRef<PostingQueryRow[]>([]);
  currentRows.current = rawRows;
  const [pendingRows, setPendingRows] = useState<PostingQueryRow[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    clearNewPostingCount();
  }, [clearNewPostingCount]);

  useEffect(() => {
    let cancelled = false;
    void (profile ? Promise.resolve() : recomputeGuestCategories(db)).then(() => db.query<PostingQueryRow>(CURRENT_JOBS_QUERY)).then((rows) => {
      if (!cancelled) {
        const previous = currentRows.current;
        const known = new Set(previous.map(row => row.id));
        if (previous.length > 0 && rows.some(row => !known.has(row.id))) {
          // Refresh existing evidence without inserting rows under someone's cursor.
          setPendingRows(rows);
          const updated = new Map(rows.map(row => [row.id, row]));
          setRawRows(previous.flatMap(row => updated.has(row.id) ? [updated.get(row.id)!] : []));
        } else {
          setRawRows(rows);
          setPendingRows(null);
        }
        setLoaded(true);
      }
    }).catch(() => { if (!cancelled) { setLoaded(true); toast('Could not load your jobs. Please reopen this page.', 'error'); } });
    return () => { cancelled = true; };
  }, [db, refreshKey, syncStatus, lastSyncedAt, profile, toast]);

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
      if (companyFilter && posting.company_slug !== companyFilter) continue;
      if (viewMode === 'for-you' && profile && posting.eligibility) {
        try {
          const eligibility = JSON.parse(posting.eligibility) as { verdict?: string };
          if (eligibility.verdict === 'ineligible') continue;
        } catch {
          // Invalid cached eligibility stays visible for manual review.
        }
      }
      if (!matchesRoleSelection(posting.category_tags, posting.domain_tags ?? [], selectedCategories, selectedDomains)) continue;
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
  }, [rawRows, search, selectedCategories, selectedDomains, viewMode, profile, companyFilter]);

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
    setSelectedDomains(new Set());
    setSearch('');
    setCompanyFilter(null);
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
    if (action === 'save' || action === 'apply') {
      void (action === 'save' ? saveJob(db, id) : markJobApplied(db, id)).then(() => {
        setRefreshKey(key => key + 1);
        toast(action === 'save' ? 'Saved to your tracker.' : 'Application recorded.');
      }).catch(() => toast('Could not save this change. Please try again.', 'error'));
      return;
    }
    if (posting.application_status && !['new', 'skipped'].includes(posting.application_status)) {
      toast('Manage this saved application in Tracker.');
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
    if (detailId) { setDetailId(null); return; }
    if (filtersOpen) {
      setFiltersOpen(false);
      return;
    }
    if (searchFocused) {
      setSearch('');
      setSearchFocused(false);
      searchRef.current?.blur();
    }
  }, [filtersOpen, searchFocused, detailId]);

  useKeyboard({
    postingIds,
    selectedIndex,
    onSelectIndex: (index) => { setSelectedIndex(index); if (detailId) setDetailId(postings[index]?.id ?? null); },
    onAction: (id, action) => handleAction(id, action === 'apply' ? 'open' : action),
    onSearchFocus: () => { searchRef.current?.focus(); setSearchFocused(true); },
    onEscape: handleEscape,
    disabled: false,
  });

  const rowRefs = useMemo(
    () => postings.map(() => createRef<HTMLDivElement>()),
    [postings],
  );

  const selectedPosting = postings.find(p => p.id === detailId);
  const newPostingTotal = pendingRows ? pendingRows.length - rawRows.length : 0;

  return (
    <div className="jobs-page">
      <div className="page-heading">
        <p className="eyebrow">MAKE YOUR NEXT MOVE</p>
        <h1>Find your next opportunity<span className="accent-dot">.</span></h1>
        <p className="mt-1 text-sm text-gray-500">
          {viewMode === 'for-you' ? 'A little closer to the work you want to do.' : 'Internships and early careers. A clearer place to start.'}
        </p>
        {profile && (
          <div className="mt-3 inline-flex rounded-md border border-gray-300 bg-white p-0.5" aria-label="Job view">
            <button
              type="button"
              aria-pressed={viewMode === 'for-you'}
              onClick={() => {
                setViewMode('for-you');
                setSelectedCategories(new Set(profile.target_categories));
                setSelectedDomains(new Set());
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
                setSelectedDomains(new Set());
                resetListPosition();
              }}
              className={`rounded px-3 py-1.5 text-sm font-medium ${viewMode === 'all' ? 'bg-violet-700 text-white' : 'text-gray-600'}`}
            >
              All jobs
            </button>
          </div>
        )}
      </div>

      <div className="jobs-toolbar">
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
            <div id="job-filter-menu" className="absolute right-0 z-30 mt-2 w-80 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 shadow-xl">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-900">Roles</p>
                <button type="button" onClick={() => setFiltersOpen(false)} className="text-xs text-gray-500 hover:text-gray-900">
                  Close
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">Choose the work you want to do. Multiple roles include either role.</p>
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
              <p className="mt-4 text-sm font-semibold text-gray-900">Fields</p>
              <p className="mt-1 text-xs text-gray-500">Optional: keep only roles in these fields. SWE + Aerospace shows aerospace software.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {DOMAIN_OPTIONS.map(option => (
                  <button key={option.value} type="button" aria-pressed={selectedDomains.has(option.value)}
                    onClick={() => {
                      setSelectedDomains(previous => {
                        const next = new Set(previous);
                        if (next.has(option.value)) next.delete(option.value);
                        else next.add(option.value);
                        return next;
                      });
                      resetListPosition();
                    }}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium ${selectedDomains.has(option.value) ? 'border-violet-700 bg-violet-700 text-white' : 'border-gray-300 text-gray-600 hover:border-gray-500'}`}>
                    {option.label}
                  </button>
                ))}
              </div>
              {selectedDomains.size > 0 && (
                <button type="button" onClick={() => setSelectedDomains(new Set())} className="mt-3 text-xs font-medium text-violet-700">Any field</button>
              )}
              {selectedCategories.size > 0 && (
                <button type="button" onClick={() => setSelectedCategories(new Set())} className="mt-4 text-xs font-medium text-violet-700 hover:text-violet-900">
                  Show all roles
                </button>
              )}
            </div>
          )}
        </div>

        {(selectedCategories.size > 0 || selectedDomains.size > 0 || search || companyFilter) && (
          <button type="button" onClick={clearFilters} className="px-2 py-2 text-sm text-gray-500 hover:text-gray-900">
            Reset
          </button>
        )}
      </div>

      {(selectedCategories.size > 0 || selectedDomains.size > 0) && (
        <p className="filter-summary mb-3 text-xs text-gray-500" aria-live="polite">
          Roles: {selectedCategories.size ? CATEGORY_OPTIONS.filter(option => selectedCategories.has(option.value)).map(option => option.shortLabel).join(' or ') : 'Any'}
          {' · Fields: '}
          {selectedDomains.size ? DOMAIN_OPTIONS.filter(option => selectedDomains.has(option.value)).map(option => option.label).join(' or ') : 'Any'}
        </p>
      )}

      <div className="results-heading"><span>{postings.length.toLocaleString()} opportunities{companyFilter ? ' at this company' : ''}</span><span>{viewMode === 'for-you' ? 'For your preferences' : 'Newest first'}</span></div>
      {pendingRows && <button className="new-results" onClick={() => { setRawRows(pendingRows); setPendingRows(null); resetListPosition(); }}>
        {newPostingTotal} new {newPostingTotal === 1 ? 'role' : 'roles'} available <span>Show <Icon name="arrow" size={14} /></span>
      </button>}
      <div className={`jobs-workspace ${selectedPosting ? 'has-detail' : ''}`}>
      {!loaded || (syncStatus === 'syncing' && rawRows.length === 0) ? (
        <div className="jobs-skeleton" role="status" aria-label="Loading jobs">{Array.from({ length: 8 }, (_, i) => <div className="skeleton-row" key={i}><span /><div><i /><i /></div></div>)}</div>
      ) : postings.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white px-6 py-16 text-center">
          <p className="text-sm font-medium text-gray-900">
            {emptyState.title}
          </p>
          {emptyState.detail ? (
            <p className="mt-2 text-sm text-gray-500">{emptyState.detail}</p>
          ) : (selectedCategories.size > 0 || selectedDomains.size > 0 || search) && (
            <button type="button" onClick={clearFilters} className="mt-3 text-sm font-medium text-violet-700 hover:text-violet-900">
              Show all jobs
            </button>
          )}
        </div>
      ) : (
        <div ref={virtualContainerRef} role="list" aria-label="Job postings" className="job-list">
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
                    onSelect={() => { setSelectedIndex(index); setDetailId(posting.id); }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedPosting ? <JobDetail key={selectedPosting.id} posting={selectedPosting} onClose={() => {
        setDetailId(null);
        requestAnimationFrame(() => rowRefs[selectedIndex]?.current?.querySelector('button')?.focus({ preventScroll: true }));
      }} onAction={handleAction} />
        : <div className="detail-placeholder"><Icon name="jobs" size={28} /><h2>A closer look.</h2><p>Select a role to explore the details,<br />save it, or take the next step.</p><span className="keyboard-hint"><kbd>↑</kbd><kbd>↓</kbd> to browse</span></div>}
      </div>
      {undoState && (
        <UndoToast title={undoState.title} onUndo={handleUndo} onDismiss={() => setUndoState(null)} />
      )}
    </div>
  );
}
