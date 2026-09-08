import { useState } from 'react';
import {
  type Profile,
  WORK_AUTH_OPTIONS,
  DEGREE_TYPE_OPTIONS,
  type DegreeType,
  CATEGORY_GROUPS,
  computeGradWindow,
  inferRequiresSponsorship,
} from './types';

interface ProfileSetupProps {
  initialProfile?: Profile | null;
  onComplete: (profile: Profile) => void;
  onBack: () => void;
}

interface Step1State {
  degreeType: DegreeType | '';
  graduationYear: string;
  graduationMonth: string;
  workAuth: string;
  requiresSponsorship: boolean | null;
  showSponsorshipQuestion: boolean;
}

interface Step2State {
  targetCategories: string[];
  locations: string[];
  locationInput: string;
}

const MONTHS = [
  { value: '01', label: 'January' },
  { value: '02', label: 'February' },
  { value: '03', label: 'March' },
  { value: '04', label: 'April' },
  { value: '05', label: 'May' },
  { value: '06', label: 'June' },
  { value: '07', label: 'July' },
  { value: '08', label: 'August' },
  { value: '09', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' },
] as const;

function buildGraduationYears(): string[] {
  const currentYear = new Date().getFullYear();
  const years: string[] = [];
  for (let y = currentYear; y <= currentYear + 6; y++) {
    years.push(String(y));
  }
  return years;
}

export function ProfileSetup({ onComplete, onBack, initialProfile }: ProfileSetupProps): React.ReactNode {
  const [step, setStep] = useState<1 | 2>(1);
  const [step1, setStep1] = useState<Step1State>({
    degreeType: initialProfile?.degree_type ?? '',
    graduationYear: initialProfile?.graduation.split('-')[0] ?? '',
    graduationMonth: initialProfile?.graduation.split('-')[1] ?? '05',
    workAuth: initialProfile?.work_auth ?? '',
    requiresSponsorship: initialProfile?.requires_sponsorship ?? null,
    showSponsorshipQuestion: false,
  });
  const [step2, setStep2] = useState<Step2State>({
    targetCategories: initialProfile?.target_categories ?? [],
    locations: initialProfile?.locations ?? ['US'],
    locationInput: '',
  });

  const graduationYears = buildGraduationYears();

  const handleWorkAuthChange = (workAuth: string): void => {
    const inferred = inferRequiresSponsorship(workAuth);
    setStep1((prev) => ({
      ...prev,
      workAuth,
      requiresSponsorship: inferred,
      showSponsorshipQuestion: inferred === null,
    }));
  };

  const handleCategoryToggle = (category: string): void => {
    setStep2((prev) => ({
      ...prev,
      targetCategories: prev.targetCategories.includes(category)
        ? prev.targetCategories.filter((c) => c !== category)
        : [...prev.targetCategories, category],
    }));
  };

  const handleAddLocation = (): void => {
    const trimmed = step2.locationInput.trim();
    if (trimmed && !step2.locations.includes(trimmed)) {
      setStep2((prev) => ({
        ...prev,
        locations: [...prev.locations, trimmed],
        locationInput: '',
      }));
    }
  };

  const handleRemoveLocation = (location: string): void => {
    setStep2((prev) => ({
      ...prev,
      locations: prev.locations.filter((l) => l !== location),
    }));
  };

  const handleLocationKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddLocation();
    }
  };

  const isStep1Valid =
    step1.degreeType !== '' &&
    step1.graduationYear !== '' &&
    step1.workAuth !== '' &&
    step1.requiresSponsorship !== null;

  const isStep2Valid = step2.targetCategories.length > 0;

  const handleFinish = (): void => {
    const graduation = `${step1.graduationYear}-${step1.graduationMonth}`;
    const profile: Profile = {
      ...initialProfile,
      degree_type: step1.degreeType as DegreeType,
      graduation,
      grad_window: computeGradWindow(graduation),
      // Retained in the persisted schema for backwards compatibility. Graduation
      // date is the single source of education timing in the current setup flow.
      current_class_year: 'unknown',
      work_auth: step1.workAuth,
      requires_sponsorship: step1.requiresSponsorship!,
      target_categories: step2.targetCategories,
      locations: step2.locations,
      excluded_companies: initialProfile?.excluded_companies ?? [],
      tiers: initialProfile?.tiers ?? {},
      contacts: initialProfile?.contacts ?? {},
    };
    onComplete(profile);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-nj-bg">
      <div className="w-full max-w-lg mx-4">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-nj-text">
            Welcome to Nightjar
          </h1>
          <p className="mt-2 text-gray-600 dark:text-nj-muted">
            Set up your profile to personalize your feed
          </p>
          <div className="flex justify-center gap-2 mt-4">
            <StepDot active={step === 1} />
            <StepDot active={step === 2} />
          </div>
        </div>

        <div className="bg-white dark:bg-nj-surface rounded-lg shadow-sm border border-gray-200 dark:border-nj-border p-6">
          {step === 1 ? (
            <div className="space-y-5">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-nj-text">
                About you
              </h2>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim mb-1">
                  Expected graduation
                </label>
                <div className="flex gap-3">
                  <select
                    value={step1.graduationMonth}
                    onChange={(e) =>
                      setStep1((prev) => ({ ...prev, graduationMonth: e.target.value }))
                    }
                    className="flex-1 rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-surface-2 px-3 py-2 text-sm text-gray-900 dark:text-nj-text"
                  >
                    {MONTHS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={step1.graduationYear}
                    onChange={(e) =>
                      setStep1((prev) => ({ ...prev, graduationYear: e.target.value }))
                    }
                    className="flex-1 rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-surface-2 px-3 py-2 text-sm text-gray-900 dark:text-nj-text"
                  >
                    <option value="">Year</option>
                    {graduationYears.map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim mb-1">
                  Degree type
                </label>
                <select
                  value={step1.degreeType}
                  onChange={(event) => setStep1((previous) => ({
                    ...previous,
                    degreeType: event.target.value as DegreeType,
                  }))}
                  className="w-full rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-surface-2 px-3 py-2 text-sm text-gray-900 dark:text-nj-text"
                >
                  <option value="">Select degree type</option>
                  {DEGREE_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim mb-1">
                  Work authorization
                </label>
                <select
                  value={step1.workAuth}
                  onChange={(e) => handleWorkAuthChange(e.target.value)}
                  className="w-full rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-surface-2 px-3 py-2 text-sm text-gray-900 dark:text-nj-text"
                >
                  <option value="">Select work authorization</option>
                  {WORK_AUTH_OPTIONS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </div>

              {step1.showSponsorshipQuestion && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim mb-1">
                    Do you require visa sponsorship?
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        setStep1((prev) => ({ ...prev, requiresSponsorship: true }))
                      }
                      className={`flex-1 py-2 px-4 rounded-md text-sm font-medium border transition-colors ${
                        step1.requiresSponsorship === true
                          ? 'bg-nj-accent text-white border-nj-accent'
                          : 'bg-white dark:bg-nj-surface-2 text-gray-700 dark:text-nj-text-dim border-gray-300 dark:border-nj-border hover:border-nj-accent'
                      }`}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setStep1((prev) => ({ ...prev, requiresSponsorship: false }))
                      }
                      className={`flex-1 py-2 px-4 rounded-md text-sm font-medium border transition-colors ${
                        step1.requiresSponsorship === false
                          ? 'bg-nj-accent text-white border-nj-accent'
                          : 'bg-white dark:bg-nj-surface-2 text-gray-700 dark:text-nj-text-dim border-gray-300 dark:border-nj-border hover:border-nj-accent'
                      }`}
                    >
                      No
                    </button>
                  </div>
                </div>
              )}

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={onBack}
                  className="px-4 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={!isStep1Valid}
                  onClick={() => setStep(2)}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-nj-accent text-white hover:bg-nj-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-nj-text">
                What you're looking for
              </h2>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim mb-2">
                  Target categories
                </label>
                <div className="space-y-3">
                  {CATEGORY_GROUPS.map((group) => (
                    <fieldset key={group.label}>
                      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-nj-muted">
                        {group.label}
                      </legend>
                      <div className="flex flex-wrap gap-2">
                        {group.options.map((cat) => (
                          <button
                            key={cat.value}
                            type="button"
                            aria-pressed={step2.targetCategories.includes(cat.value)}
                            onClick={() => handleCategoryToggle(cat.value)}
                            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                              step2.targetCategories.includes(cat.value)
                                ? 'bg-nj-accent text-white border-nj-accent'
                                : 'bg-white dark:bg-nj-surface-2 text-gray-700 dark:text-nj-text-dim border-gray-300 dark:border-nj-border hover:border-nj-accent'
                            }`}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-nj-text-dim mb-1">
                  Target locations
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {step2.locations.map((loc) => (
                    <span
                      key={loc}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm bg-gray-100 dark:bg-nj-surface-2 text-gray-700 dark:text-nj-text-dim"
                    >
                      {loc}
                      <button
                        type="button"
                        onClick={() => handleRemoveLocation(loc)}
                        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                        aria-label={`Remove ${loc}`}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={step2.locationInput}
                    onChange={(e) =>
                      setStep2((prev) => ({ ...prev, locationInput: e.target.value }))
                    }
                    onKeyDown={handleLocationKeyDown}
                    placeholder="Add a location (e.g. NYC, California)"
                    className="flex-1 rounded-md border border-gray-300 dark:border-nj-border bg-white dark:bg-nj-surface-2 px-3 py-2 text-sm text-gray-900 dark:text-nj-text placeholder-gray-400"
                  />
                  <button
                    type="button"
                    onClick={handleAddLocation}
                    className="px-3 py-2 rounded-md text-sm font-medium border border-gray-300 dark:border-nj-border text-gray-700 dark:text-nj-text-dim hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-nj-text-dim hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={!isStep2Valid}
                  onClick={handleFinish}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-nj-accent text-white hover:bg-nj-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Get started
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepDot({ active }: { active: boolean }): React.ReactNode {
  return (
    <div
      className={`w-2 h-2 rounded-full transition-colors ${
        active ? 'bg-nj-accent' : 'bg-gray-300 dark:bg-nj-border'
      }`}
    />
  );
}
