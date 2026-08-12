import { createContext, useContext, type ReactNode } from 'react';

export interface Profile {
  graduation: string;
  grad_window: [string, string];
  current_class_year: string;
  work_auth: string;
  requires_sponsorship: boolean;
  target_categories: string[];
  locations: string[];
  excluded_companies: string[];
  tiers: Record<string, 1 | 2 | 3>;
  contacts: Record<string, string>;
}

interface ProfileContextValue {
  profile: Profile | null;
  updateProfile: (profile: Profile) => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider');
  return ctx;
}

export function ProfileProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <ProfileContext.Provider value={{ profile: null, updateProfile: () => {} }}>
      {children}
    </ProfileContext.Provider>
  );
}
