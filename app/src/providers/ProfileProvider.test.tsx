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

    expect(screen.getByText('guest browsing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Browse jobs' })).toBeNull();
  });

  it('does not ask for a redundant class year', () => {
    render(<ProfileProvider><TestApp /></ProfileProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Set preferences' }));

    expect(screen.getByText('Expected graduation')).toBeTruthy();
    expect(screen.queryByText('Class year')).toBeNull();
  });

  it('allows a guest to open personalization later', () => {
    localStorage.setItem('nightjar_onboarding_dismissed', 'true');
    render(<ProfileProvider><TestApp /></ProfileProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Set preferences' }));

    expect(screen.getByText('Expected graduation')).toBeTruthy();
  });

  it('deletes a saved profile and returns to guest browsing', () => {
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
    expect(screen.getByText('guest browsing')).toBeTruthy();
  });

  it('preserves saved preferences without a reset marker', () => {
    localStorage.setItem('nightjar_onboarding_dismissed', 'true');
    const saved = JSON.stringify({ degree_type: 'bachelors', graduation: '2029-05', work_auth: 'us_citizen', requires_sponsorship: false, target_categories: ['swe'], tiers: {}, contacts: {} });
    localStorage.setItem('nightjar_profile', saved);

    render(<ProfileProvider><TestApp /></ProfileProvider>);

    expect(localStorage.getItem('nightjar_profile')).toBe(saved);
    expect(localStorage.getItem('nightjar_onboarding_dismissed')).toBe('true');
    expect(localStorage.getItem('nightjar_profile_reset_v1')).toBeNull();
    expect(screen.getByText('profile loaded')).toBeTruthy();
  });
  it('keeps existing preferences when opening and cancelling the editor', () => {
    localStorage.setItem('nightjar_onboarding_dismissed', 'true');
    const profile = JSON.stringify({ degree_type: 'bachelors', graduation: '2029-05',
      work_auth: 'us_citizen', requires_sponsorship: false, target_categories: ['swe'],
      tiers: { example: 1 }, contacts: { example: 'Private note' } });
    localStorage.setItem('nightjar_profile', profile);
    render(<ProfileProvider><TestApp /></ProfileProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Set preferences' }));
    expect(localStorage.getItem('nightjar_profile')).toBe(profile);
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByText('profile loaded')).toBeTruthy();
    expect(localStorage.getItem('nightjar_profile')).toBe(profile);
  });
});
