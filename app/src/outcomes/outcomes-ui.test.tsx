import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutcomeDialog } from './OutcomeDialog';
import { InsightsDashboard } from '@/views/Insights/InsightsView';
import { EMPTY_INSIGHTS_MESSAGE, type OutcomeAnalysis } from '@/engine/recalibrate';

afterEach(cleanup);

function analysisFixture(): OutcomeAnalysis {
  return {
    ready: true,
    recordedOutcomeCount: 12,
    message: 'These are patterns in your history, not causal conclusions.',
    suggestions: [{
      id: 'tier:2',
      message: 'Pattern in your history (12 applications): Tier 2 reached more interviews. Small sample.',
      adjustment: { kind: 'tier_bonus', tier: 2, points: 5 },
    }],
    observations: ['Pattern in your history (12 outcomes): Example Co responded in 2 days.'],
    stats: {
      applicationsSent: 12,
      interviewed: 4,
      offers: 1,
      interviewRate: 33.3,
      offerRate: 8.3,
      averageResponseDays: 3.5,
      byCategory: [{
        key: 'swe', label: 'SWE', applied: 12, interviewed: 4, offered: 1,
        ghosted: 2, interviewRate: 33.3, offerRate: 8.3, ghostRate: 16.7,
      }],
      byTier: [{
        key: '2', label: 'Tier 2', applied: 12, interviewed: 4, offered: 1,
        ghosted: 2, interviewRate: 33.3, offerRate: 8.3, ghostRate: 16.7,
      }],
      timeline: [{ weekStart: '2026-08-31', applications: 12, interviews: 4 }],
    },
  };
}

describe('OutcomeDialog', () => {
  it('collects optional interview rounds and notes', () => {
    const onSubmit = vi.fn();
    render(
      <OutcomeDialog
        company="Example Co"
        title="Software Engineering Intern"
        status="phone"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Interview rounds completed (optional)'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('What happened? (optional)'), {
      target: { value: 'Great conversation.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save outcome' }));

    expect(onSubmit).toHaveBeenCalledWith({
      interviewRounds: 2,
      notes: 'Great conversation.',
    });
  });

  it('lets the user skip every optional detail without cancelling the move', () => {
    const onSubmit = vi.fn();
    render(
      <OutcomeDialog
        company="Example Co"
        title="Design Intern"
        status="rejected"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip details' }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it('is keyboard dismissible and exposes an accessible dialog name', () => {
    const onCancel = vi.fn();
    render(
      <OutcomeDialog
        company="Example Co"
        title="Finance Intern"
        status="offer"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Record offer outcome' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables repeat actions while an outcome is being saved', () => {
    render(
      <OutcomeDialog
        company="Example Co"
        title="Finance Intern"
        status="offer"
        busy
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Saving outcome' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Skip details' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Cancel move' })).toHaveProperty('disabled', true);
  });
});

describe('InsightsDashboard', () => {
  it('shows the planned empty message when there are no applications', () => {
    const empty = analysisFixture();
    empty.ready = false;
    empty.message = EMPTY_INSIGHTS_MESSAGE;
    empty.suggestions = [];
    empty.observations = [];
    empty.stats = {
      applicationsSent: 0,
      interviewed: 0,
      offers: 0,
      interviewRate: 0,
      offerRate: 0,
      averageResponseDays: null,
      byCategory: [],
      byTier: [],
      timeline: [],
    };
    render(
      <InsightsDashboard
        analysis={empty}
        decisions={{}}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(EMPTY_INSIGHTS_MESSAGE)).toBeTruthy();
  });

  it('renders stats, breakdowns, timeline, and explicit suggestion actions', () => {
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const analysis = analysisFixture();
    render(
      <InsightsDashboard
        analysis={analysis}
        decisions={{}}
        onApply={onApply}
        onDismiss={onDismiss}
      />,
    );

    const summary = screen.getByRole('region', { name: 'Application statistics' });
    expect(within(summary).getByText('12')).toBeTruthy();
    expect(within(summary).getByText('33.3%')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Outcomes by category' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Outcomes by tier' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Applications and interviews by week' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    expect(onApply).toHaveBeenCalledWith(analysis.suggestions[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion' }));
    expect(onDismiss).toHaveBeenCalledWith('tier:2');
  });

  it('hides controls for a previously dismissed suggestion', () => {
    render(
      <InsightsDashboard
        analysis={analysisFixture()}
        decisions={{ 'tier:2': 'dismissed' }}
        onApply={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Apply suggestion' })).toBeNull();
    expect(screen.getByText('Dismissed')).toBeTruthy();
  });
});
