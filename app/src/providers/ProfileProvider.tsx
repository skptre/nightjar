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
const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}

export function ProfileProvider({ children }: { children: ReactNode }): ReactNode {
  const [profile, setProfile] = useState<Profile | null>(() => loadProfile());
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
      setShowSetup(false);
    },
    [],
  );

  const beginProfileSetup = useCallback((): void => {
    setShowSetup(true);
  }, []);

  const deleteProfile = useCallback((): void => {
    clearProfile();
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    setProfile(null);
    setShowSetup(false);
  }, []);

  if (showSetup) {
    return <ProfileSetup initialProfile={profile} onComplete={handleSetupComplete} onBack={() => setShowSetup(false)} />;
  }
  return (
    <ProfileContext.Provider value={{ profile, updateProfile, beginProfileSetup, deleteProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}
