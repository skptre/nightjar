import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProfileSetup } from './ProfileSetup';

afterEach(cleanup);

it('lets people start with required matching details and add roles or locations later', () => {
  const complete = vi.fn();
  render(<ProfileSetup onComplete={complete} onBack={() => {}} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Graduation year' }),
    { target: { value: String(new Date().getFullYear()) } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Work authorization' }),
    { target: { value: 'us_citizen' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to interests' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start browsing jobs' }));
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({
    degree_type: undefined, target_categories: [], locations: [], work_auth: 'us_citizen',
  }));
});
