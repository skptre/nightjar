import { Brand, Icon } from '@/components/Icon';
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
    window.history.replaceState(null, '', '/jobs');
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);

  const beginProfileSetup = useCallback((): void => {
    setShowSetup(true);
  }, []);

  const deleteProfile = useCallback((): void => {
    clearProfile();
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY);
    setProfile(null);
    setSetupDismissed(false);
    setShowSetup(false);
  }, []);

  if (showSetup) {
    return <ProfileSetup initialProfile={profile} onComplete={handleSetupComplete} onBack={() => setShowSetup(false)} />;
  }
  if (!profile && !setupDismissed) {
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
  return <main className="welcome-page"><Brand />
    <div className="welcome-body"><section className="welcome-copy"><div className="eyebrow">A LITTLE LESS NOISE. A LOT MORE POSSIBILITY.</div>
      <h1>Your next chapter.<br />A clearer start</h1>
      <p>Find the work that interests you. Keep your applications together. Make your next move with a little more clarity.</p>
      <div className="welcome-actions"><button className="button-primary" onClick={onBrowse}>Browse jobs <Icon name="arrow" size={16} /></button><button className="button-secondary" onClick={onPersonalize}>Personalize results</button></div>
      <p className="!text-xs !mt-5">No account required. Start exploring in one click.</p>
    </section><section className="welcome-preview" aria-label="How Nightjar works"><div className="section-label"><span>Your next move</span><Icon name="jobs" size={16} /></div>
      <div className="welcome-step"><span>01</span><div><h2>Find your kind of work.</h2><p>Explore roles across fields. Read the details that matter.</p></div></div>
      <div className="welcome-step"><span>02</span><div><h2>Keep the good ones close.</h2><p>Save opportunities. Follow companies you care about.</p></div></div>
      <div className="welcome-step"><span>03</span><div><h2>Make space for what’s next.</h2><p>Applications, dates and notes. All in one familiar place.</p></div></div>
    </section></div><footer className="welcome-footer"><span>Built for the beginning of something.</span><span>Your tracker stays in this browser or device.</span></footer>
  </main>;
}
