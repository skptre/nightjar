import { useState } from 'react';
import {
  type Profile,
  WORK_AUTH_OPTIONS,
  CLASS_YEAR_OPTIONS,
  CATEGORY_GROUPS,
  computeGradWindow,
  inferRequiresSponsorship,
} from './types';

interface ProfileSetupProps {
  onComplete: (profile: Profile) => void;
}

interface Step1State {
  graduationYear: string;
  graduationMonth: string;
  classYear: string;
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

export function ProfileSetup({ onComplete }: ProfileSetupProps): React.ReactNode {
  const [step, setStep] = useState<1 | 2>(1);
  const [step1, setStep1] = useState<Step1State>({
    graduationYear: '',
    graduationMonth: '05',
    classYear: '',
    workAuth: '',
    requiresSponsorship: null,
    showSponsorshipQuestion: false,
  });
  const [step2, setStep2] = useState<Step2State>({
    targetCategories: [],
    locations: ['US'],
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
    step1.graduationYear !== '' &&
    step1.classYear !== '' &&
    step1.workAuth !== '' &&
    step1.requiresSponsorship !== null;

  const isStep2Valid = step2.targetCategories.length > 0;

  const handleFinish = (): void => {
    const graduation = `${step1.graduationYear}-${step1.graduationMonth}`;
    const profile: Profile = {
      graduation,
      grad_window: computeGradWindow(graduation),
      current_class_year: step1.classYear,
      work_auth: step1.workAuth,
      requires_sponsorship: step1.requiresSponsorship!,
      target_categories: step2.targetCategories,
      locations: step2.locations,
      excluded_companies: [],
      tiers: {},
      contacts: {},
    };
    onComplete(profile);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="w-full max-w-lg mx-4">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Welcome to Nightjar
          </h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Set up your profile to personalize your feed
          </p>
          <div className="flex justify-center gap-2 mt-4">
            <StepDot active={step === 1} />
            <StepDot active={step === 2} />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-6">
          {step === 1 ? (
            <div className="space-y-5">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                About you
              </h2>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Expected graduation
                </label>
                <div className="flex gap-3">
                  <select
                    value={step1.graduationMonth}
                    onChange={(e) =>
                      setStep1((prev) => ({ ...prev, graduationMonth: e.target.value }))
                    }
                    className="flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
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
                    className="flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
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
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Class year
                </label>
                <select
                  value={step1.classYear}
                  onChange={(e) =>
                    setStep1((prev) => ({ ...prev, classYear: e.target.value }))
                  }
                  className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                >
                  <option value="">Select class year</option>
                  {CLASS_YEAR_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Work authorization
                </label>
                <select
                  value={step1.workAuth}
                  onChange={(e) => handleWorkAuthChange(e.target.value)}
                  className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
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
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-700 hover:border-blue-400'
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
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-700 hover:border-blue-400'
                      }`}
                    >
                      No
                    </button>
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  disabled={!isStep1Valid}
                  onClick={() => setStep(2)}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                What you're looking for
              </h2>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Target categories
                </label>
                <div className="space-y-3">
                  {CATEGORY_GROUPS.map((group) => (
                    <fieldset key={group.label}>
                      <legend className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
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
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-700 hover:border-blue-400'
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
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Target locations
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {step2.locations.map((loc) => (
                    <span
                      key={loc}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
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
                    className="flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400"
                  />
                  <button
                    type="button"
                    onClick={handleAddLocation}
                    className="px-3 py-2 rounded-md text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>

              <div className="flex justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={!isStep2Valid}
                  onClick={handleFinish}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
        active ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'
      }`}
    />
  );
}
