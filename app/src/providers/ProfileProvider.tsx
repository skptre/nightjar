import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Profile } from '@/profile/types';
import { loadProfile, saveProfile } from '@/profile/profile-store';
import { ProfileSetup } from '@/profile/ProfileSetup';

interface ProfileContextValue {
  profile: Profile | null;
  updateProfile: (updates: Partial<Profile>) => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}

export function ProfileProvider({ children }: { children: ReactNode }): ReactNode {
  const [profile, setProfile] = useState<Profile | null>(() => loadProfile());

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
      setProfile(newProfile);
    },
    [],
  );

  if (!profile) {
    return <ProfileSetup onComplete={handleSetupComplete} />;
  }

  return (
    <ProfileContext.Provider value={{ profile, updateProfile }}>
      {children}
    </ProfileContext.Provider>
  );
}
