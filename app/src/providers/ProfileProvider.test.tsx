import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileProvider, useProfile } from './ProfileProvider';

function TestApp(): React.ReactNode {
  const { profile, beginProfileSetup, deleteProfile } = useProfile();
  return (
    <div>
      <span>{profile ? 'profile loaded' : 'guest browsing'}</span>
      <button type="button" onClick={beginProfileSetup}>Set preferences</button>
      <button type="button" onClick={deleteProfile}>Delete profile</button>
    </div>
  );
}

describe('ProfileProvider onboarding', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('lets a new user browse without completing a profile', () => {
    render(<ProfileProvider><TestApp /></ProfileProvider>);

    expect(screen.getByRole('button', { name: 'Browse jobs' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse jobs' }));

    expect(screen.getByText('guest browsing')).toBeTruthy();
    expect(localStorage.getItem('nightjar_onboarding_dismissed')).toBe('true');
  });

  it('does not ask for a redundant class year', () => {
    render(<ProfileProvider><TestApp /></ProfileProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Personalize results' }));

    expect(screen.getByText('Expected graduation')).toBeTruthy();
    expect(screen.queryByText('Class year')).toBeNull();
  });

  it('allows a guest to open personalization later', () => {
    localStorage.setItem('nightjar_profile_reset_v1', 'done');
    localStorage.setItem('nightjar_onboarding_dismissed', 'true');
    render(<ProfileProvider><TestApp /></ProfileProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Set preferences' }));

    expect(screen.getByText('Expected graduation')).toBeTruthy();
  });

  it('deletes a saved profile and returns to the welcome screen', () => {
    localStorage.setItem('nightjar_profile_reset_v1', 'done');
    localStorage.setItem('nightjar_onboarding_dismissed', 'true');
    localStorage.setItem('nightjar_profile', JSON.stringify({
      graduation: '2029-05',
      work_auth: 'us_citizen',
      requires_sponsorship: false,
      target_categories: ['swe'],
    }));
    render(<ProfileProvider><TestApp /></ProfileProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));

    expect(localStorage.getItem('nightjar_profile')).toBeNull();
    expect(localStorage.getItem('nightjar_onboarding_dismissed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Browse jobs' })).toBeTruthy();
  });

  it('clears the pre-redesign profile once in each runtime', () => {
    localStorage.setItem('nightjar_onboarding_dismissed', 'true');
    localStorage.setItem('nightjar_profile', '{"graduation":"2029-05"}');

    render(<ProfileProvider><TestApp /></ProfileProvider>);

    expect(localStorage.getItem('nightjar_profile')).toBeNull();
    expect(localStorage.getItem('nightjar_onboarding_dismissed')).toBeNull();
    expect(localStorage.getItem('nightjar_profile_reset_v1')).toBe('done');
    expect(screen.getByRole('button', { name: 'Browse jobs' })).toBeTruthy();
  });
});
