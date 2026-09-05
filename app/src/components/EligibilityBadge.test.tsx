import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EligibilityBadge } from './EligibilityBadge';

describe('EligibilityBadge', () => {
  it('does not claim a description was read when it is unavailable', () => {
    render(<EligibilityBadge
      eligibilityJson={JSON.stringify({ verdict: 'unclear', reasons: [], flags: [] })}
      descriptionAvailable={false}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Details needed' }));
    expect(screen.getByText(/has not received the job description/i)).toBeTruthy();
  });

  it('uses a human label after reviewing a description with no conflicts', () => {
    render(<EligibilityBadge
      eligibilityJson={JSON.stringify({ verdict: 'unclear', reasons: [], flags: [] })}
      descriptionAvailable
    />);

    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });
});
