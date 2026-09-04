import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProfileProvider, useProfile } from './ProfileProvider';

function TestApp(): React.ReactNode {
  const { profile, beginProfileSetup } = useProfile();
  return (
    <div>
      <span>{profile ? 'profile loaded' : 'guest browsing'}</span>
      <button type="button" onClick={beginProfileSetup}>Set preferences</button>
    </div>
  );
}

describe('ProfileProvider onboarding', () => {
  beforeEach(() => localStorage.clear());

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
    localStorage.setItem('nightjar_onboarding_dismissed', 'true');
    render(<ProfileProvider><TestApp /></ProfileProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Set preferences' }));

    expect(screen.getByText('Expected graduation')).toBeTruthy();
  });
});
