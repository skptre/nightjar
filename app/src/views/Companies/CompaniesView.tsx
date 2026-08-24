import { useState, useMemo, useCallback } from 'react';
import { useDatabase } from '@/providers/DatabaseProvider';
import { useProfile } from '@/providers/ProfileProvider';
import { recomputeAll } from '@/classify/recompute';
import { ExcludeToggle } from './ExcludeToggle';

interface CompanyRow {
  slug: string;
  name: string;
  source: string;
  postingCount: number;
  latestPosting: string | null;
}

interface PostingQueryRow {
  data: string;
  first_seen_at: string | null;
  closed_at: string | null;
}

type SortKey = 'name' | 'count' | 'recent' | 'tier';
type SortDir = 'asc' | 'desc';

function extractCompanyData(data: string): { company: string; company_slug: string; source: string } | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return {
      company: (parsed['company'] as string) ?? '',
      company_slug: (parsed['company_slug'] as string) ?? '',
      source: (parsed['source'] as string) ?? '',
    };
  } catch {
    return null;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function tierLabel(tier: 1 | 2 | 3 | undefined): string {
  if (tier === 1) return 'T1';
  if (tier === 2) return 'T2';
  if (tier === 3) return 'T3';
  return '—';
}

function tierSortValue(tier: 1 | 2 | 3 | undefined): number {
  if (tier === 1) return 1;
  if (tier === 2) return 2;
  if (tier === 3) return 3;
  return 4;
}

export function CompaniesView(): React.ReactNode {
  const { db } = useDatabase();
  const { profile, updateProfile } = useProfile();

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [editingContact, setEditingContact] = useState<string | null>(null);
  const [contactValue, setContactValue] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const companies = useMemo(() => {
    void refreshKey;
    const rows = db.query<PostingQueryRow>(
      'SELECT data, first_seen_at, closed_at FROM postings_cache WHERE closed_at IS NULL',
    );

    const map = new Map<string, CompanyRow>();

    for (const row of rows) {
      const info = extractCompanyData(row.data);
      if (!info || !info.company_slug) continue;

      const existing = map.get(info.company_slug);
      if (existing) {
        existing.postingCount++;
        if (row.first_seen_at && (!existing.latestPosting || row.first_seen_at > existing.latestPosting)) {
          existing.latestPosting = row.first_seen_at;
        }
      } else {
        map.set(info.company_slug, {
          slug: info.company_slug,
          name: info.company,
          source: info.source,
          postingCount: 1,
          latestPosting: row.first_seen_at,
        });
      }
    }

    return Array.from(map.values());
  }, [db, refreshKey]);

  const filteredCompanies = useMemo(() => {
    let list = companies;

    if (search) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'count':
          cmp = a.postingCount - b.postingCount;
          break;
        case 'recent':
          cmp = (a.latestPosting ?? '').localeCompare(b.latestPosting ?? '');
          break;
        case 'tier':
          cmp = tierSortValue(profile?.tiers[a.slug]) - tierSortValue(profile?.tiers[b.slug]);
          break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return list;
  }, [companies, search, sortKey, sortDir, profile?.tiers]);

  const excludedSet = useMemo(
    () => new Set(profile?.excluded_companies ?? []),
    [profile?.excluded_companies],
  );

  const handleSort = useCallback((key: SortKey): void => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir(key === 'count' || key === 'recent' ? 'desc' : 'asc');
      return key;
    });
  }, []);

  const handleTierChange = useCallback(
    (slug: string, value: string): void => {
      if (!profile) return;

      const newTiers = { ...profile.tiers };
      if (value === '' || value === 'untiered') {
        delete newTiers[slug];
      } else {
        newTiers[slug] = parseInt(value, 10) as 1 | 2 | 3;
      }
      updateProfile({ tiers: newTiers });
      recomputeAll(db, { ...profile, tiers: newTiers });
      setRefreshKey((k) => k + 1);
    },
    [db, profile, updateProfile],
  );

  const handleExclude = useCallback(
    (slug: string): void => {
      if (!profile) return;

      const excluded = new Set(profile.excluded_companies);
      if (excluded.has(slug)) {
        excluded.delete(slug);
      } else {
        excluded.add(slug);
      }
      updateProfile({ excluded_companies: Array.from(excluded) });
    },
    [profile, updateProfile],
  );

  const handleStartEditContact = useCallback(
    (slug: string): void => {
      setEditingContact(slug);
      setContactValue(profile?.contacts[slug] ?? '');
    },
    [profile?.contacts],
  );

  const handleSaveContact = useCallback(
    (slug: string): void => {
      if (!profile) return;
      const newContacts = { ...profile.contacts };
      if (contactValue.trim()) {
        newContacts[slug] = contactValue.trim();
      } else {
        delete newContacts[slug];
      }
      updateProfile({ contacts: newContacts });
      setEditingContact(null);
    },
    [profile, updateProfile, contactValue],
  );

  const sortIndicator = (key: SortKey): string => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-nj-text">
            Companies
          </h2>
          <p className="text-xs text-gray-500 dark:text-nj-muted mt-0.5">
            {filteredCompanies.length} compan{filteredCompanies.length !== 1 ? 'ies' : 'y'}
            {search && ` matching "${search}"`}
          </p>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search companies..."
          className="w-56 px-3 py-1.5 text-sm border border-gray-200 dark:border-nj-border rounded-md bg-white dark:bg-nj-surface text-gray-900 dark:text-nj-text placeholder-gray-400 dark:placeholder-nj-muted focus:outline-none focus:ring-1 focus:ring-nj-accent"
        />
      </div>

      <div className="border border-gray-200 dark:border-nj-border rounded-lg overflow-hidden">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_80px_80px_90px_70px_60px] gap-2 px-4 py-2 bg-gray-50 dark:bg-nj-surface border-b border-gray-200 dark:border-nj-border text-xs font-semibold text-gray-500 dark:text-nj-muted uppercase tracking-wider">
          <button onClick={() => handleSort('name')} className="text-left hover:text-gray-700 dark:hover:text-nj-text">
            Company{sortIndicator('name')}
          </button>
          <button onClick={() => handleSort('count')} className="text-center hover:text-gray-700 dark:hover:text-nj-text">
            Posts{sortIndicator('count')}
          </button>
          <button onClick={() => handleSort('recent')} className="text-center hover:text-gray-700 dark:hover:text-nj-text">
            Latest{sortIndicator('recent')}
          </button>
          <button onClick={() => handleSort('tier')} className="text-center hover:text-gray-700 dark:hover:text-nj-text">
            Tier{sortIndicator('tier')}
          </button>
          <span className="text-center">Source</span>
          <span className="text-center">Excl.</span>
        </div>

        {/* Rows */}
        {filteredCompanies.length === 0 ? (
          <div className="py-12 text-center text-gray-500 dark:text-nj-muted text-sm">
            {search ? 'No companies match your search.' : 'No companies found. Sync to load postings.'}
          </div>
        ) : (
          filteredCompanies.map((company) => {
            const isExcluded = excludedSet.has(company.slug);
            const tier = profile?.tiers[company.slug];
            const contact = profile?.contacts[company.slug];
            const isExpanded = expandedSlug === company.slug;

            return (
              <div
                key={company.slug}
                className={`border-b border-gray-100 dark:border-nj-border last:border-b-0 ${
                  isExcluded ? 'opacity-50' : ''
                }`}
              >
                {/* Main row */}
                <div
                  className="grid grid-cols-[1fr_80px_80px_90px_70px_60px] gap-2 px-4 py-3 items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-nj-surface-2/50 transition-colors"
                  onClick={() => setExpandedSlug(isExpanded ? null : company.slug)}
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-gray-900 dark:text-nj-text truncate block">
                      {company.name}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-nj-muted">
                      {company.slug}
                    </span>
                  </div>
                  <span className="text-sm text-gray-700 dark:text-nj-text text-center tabular-nums">
                    {company.postingCount}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-nj-text-dim text-center">
                    {formatDate(company.latestPosting)}
                  </span>
                  <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={tier !== undefined ? String(tier) : ''}
                      onChange={(e) => handleTierChange(company.slug, e.target.value)}
                      className={`w-20 px-1.5 py-1 text-xs rounded border transition-colors cursor-pointer ${
                        tier === 1
                          ? 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-nj-tier-1/10 dark:text-nj-tier-1 dark:border-nj-tier-1/30'
                          : tier === 2
                            ? 'border-blue-300 bg-blue-50 text-blue-800 dark:bg-nj-tier-2/10 dark:text-nj-tier-2 dark:border-nj-tier-2/30'
                            : tier === 3
                              ? 'border-gray-300 bg-gray-50 text-gray-700 dark:bg-nj-tier-3/10 dark:text-nj-tier-3 dark:border-nj-tier-3/30'
                              : 'border-gray-200 bg-white text-gray-500 dark:bg-nj-surface dark:text-nj-muted dark:border-nj-border'
                      }`}
                    >
                      <option value="">—</option>
                      <option value="1">Tier 1</option>
                      <option value="2">Tier 2</option>
                      <option value="3">Tier 3</option>
                    </select>
                  </div>
                  <span className="text-xs text-gray-500 dark:text-nj-text-dim text-center uppercase">
                    {company.source === 'greenhouse' ? 'GH' : company.source === 'lever' ? 'LV' : company.source === 'ashby' ? 'AB' : company.source === 'workday' ? 'WD' : company.source === 'smartrecruiters' ? 'SR' : company.source === 'simplify' ? 'SIM' : company.source}
                  </span>
                  <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                    <ExcludeToggle
                      excluded={isExcluded}
                      onToggle={() => handleExclude(company.slug)}
                    />
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-4 pb-3 pt-1 bg-gray-50/50 dark:bg-nj-bg/50 space-y-2">
                    <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-nj-text-dim">
                      <span>Source: {company.source}</span>
                      <span>Tier: {tierLabel(tier)}</span>
                      <span>Active postings: {company.postingCount}</span>
                      {isExcluded && (
                        <span className="text-red-500 dark:text-nj-ineligible font-medium">Excluded from feed</span>
                      )}
                    </div>

                    {/* Contact notes */}
                    <div>
                      <p className="text-xs font-medium text-gray-600 dark:text-nj-text-dim mb-1">Contact notes</p>
                      {editingContact === company.slug ? (
                        <div className="space-y-1">
                          <textarea
                            value={contactValue}
                            onChange={(e) => setContactValue(e.target.value)}
                            rows={2}
                            className="w-full text-xs p-2 border border-gray-200 dark:border-nj-border-bright rounded bg-white dark:bg-nj-surface-2 text-gray-900 dark:text-nj-text resize-none focus:outline-none focus:ring-1 focus:ring-nj-accent"
                            placeholder="e.g., Warm intro via Sarah, applied Oct 2026"
                            autoFocus
                          />
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleSaveContact(company.slug)}
                              className="text-xs px-2 py-1 bg-nj-accent text-white rounded hover:bg-nj-accent-dim"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingContact(null)}
                              className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 dark:text-nj-text-dim dark:hover:text-nj-text"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {contact ? (
                            <div>
                              <p className="text-xs text-gray-600 dark:text-nj-text-dim whitespace-pre-wrap">{contact}</p>
                              <button
                                onClick={() => handleStartEditContact(company.slug)}
                                className="text-xs text-nj-accent dark:text-nj-accent-bright hover:underline mt-1"
                              >
                                Edit
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleStartEditContact(company.slug)}
                              className="text-xs text-gray-400 hover:text-gray-600 dark:text-nj-muted dark:hover:text-nj-text"
                            >
                              + Add contact notes
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
