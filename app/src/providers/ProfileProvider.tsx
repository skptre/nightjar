import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Profile } from '@/profile/types';
import { clearProfile, loadProfile, saveProfile } from '@/profile/profile-store';
import { ProfileSetup } from '@/profile/ProfileSetup';

interface ProfileContextValue {
  profile: Profile | null;
  updateProfile: (updates: Partial<Profile>) => void;
  beginProfileSetup: () => void;
  deleteProfile: () => void;
}

const ONBOARDING_DISMISSED_KEY = 'nightjar_onboarding_dismissed';
const PROFILE_RESET_KEY = 'nightjar_profile_reset_v1';

function loadInitialProfile(): Profile | null {
  if (localStorage.getItem(PROFILE_RESET_KEY) !== 'done') {
    clearProfile();
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    localStorage.setItem(PROFILE_RESET_KEY, 'done');
    return null;
  }
  return loadProfile();
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}

export function ProfileProvider({ children }: { children: ReactNode }): ReactNode {
  const [profile, setProfile] = useState<Profile | null>(() => loadInitialProfile());
  const [setupDismissed, setSetupDismissed] = useState(
    () => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true',
  );
  const [showSetup, setShowSetup] = useState(false);

  const updateProfile = useCallback(
    (updates: Partial<Profile>) => {
      setProfile((prev) => {
        if (!prev) return prev;
        const updated: Profile = { ...prev, ...updates };
        saveProfile(updated);
        return updated;
      });
    },
    [],
  );

  const handleSetupComplete = useCallback(
    (newProfile: Profile) => {
      saveProfile(newProfile);
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
      setProfile(newProfile);
      setSetupDismissed(true);
      setShowSetup(false);
    },
    [],
  );

  const browseWithoutProfile = useCallback((): void => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true');
    setSetupDismissed(true);
  }, []);

  const beginProfileSetup = useCallback((): void => {
    clearProfile();
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    setProfile(null);
    setSetupDismissed(false);
    setShowSetup(true);
  }, []);

  const deleteProfile = useCallback((): void => {
    clearProfile();
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    setProfile(null);
    setSetupDismissed(false);
    setShowSetup(false);
  }, []);

  if (!profile && !setupDismissed) {
    if (showSetup) {
      return (
        <ProfileSetup
          onComplete={handleSetupComplete}
          onBack={() => setShowSetup(false)}
        />
      );
    }
    return (
      <WelcomeScreen
        onBrowse={browseWithoutProfile}
        onPersonalize={() => setShowSetup(true)}
      />
    );
  }

  return (
    <ProfileContext.Provider value={{ profile, updateProfile, beginProfileSetup, deleteProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}

function WelcomeScreen({
  onBrowse,
  onPersonalize,
}: {
  onBrowse: () => void;
  onPersonalize: () => void;
}): ReactNode {
  return (
    <main className="min-h-screen bg-gray-50 px-4 flex items-center justify-center">
      <section className="w-full max-w-xl rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold tracking-wide text-violet-700">NIGHTJAR</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-gray-950">
          Find internships without the noise.
        </h1>
        <p className="mt-3 max-w-md text-gray-600">
          Browse current postings immediately, or answer a few optional questions to narrow the list.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onBrowse}
            className="rounded-md bg-violet-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-violet-800"
          >
            Browse jobs
          </button>
          <button
            type="button"
            onClick={onPersonalize}
            className="rounded-md border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Personalize results
          </button>
        </div>
        <p className="mt-4 text-xs text-gray-500">No account required. Your preferences stay on this device.</p>
      </section>
    </main>
  );
}
