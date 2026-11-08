import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { JobPhases, phaseStates } from '../JobPhases';

const PHASES = ['check', 'schema', 'records', 'finish'].map((key) => ({ key, label: key }));
const STATE_TEXT = {
  done: 'done',
  active: 'in progress',
  failed: 'failed',
  pending: 'not started',
};

describe('phaseStates', () => {
  it.each([
    [null, false, false, ['pending', 'pending', 'pending', 'pending']],
    ['check', false, false, ['active', 'pending', 'pending', 'pending']],
    ['records', false, false, ['done', 'done', 'active', 'pending']],
    ['records', false, true, ['done', 'done', 'failed', 'pending']],
    ['finish', true, false, ['done', 'done', 'done', 'done']],
    ['unknown', false, false, ['pending', 'pending', 'pending', 'pending']],
  ] as const)('current %s, finished %s, failed %s', (current, finished, failed, expected) => {
    expect(phaseStates(PHASES, current, finished, failed)).toEqual(expected);
  });
});

describe('JobPhases', () => {
  it('a progress bar with its value, and each phase with its state in words', async () => {
    const { container } = render(
      <JobPhases
        phases={PHASES}
        current="records"
        progress={0.456}
        label="Import progress"
        valueText="46%"
        stateText={STATE_TEXT}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Import progress' });
    expect(bar).toHaveAttribute('aria-valuenow', '46');
    expect(bar).toHaveAttribute('aria-valuetext', '46%');
    const items = within(screen.getByTestId('job-phases')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'checkdone',
      'schemadone',
      'recordsin progress',
      'finishnot started',
    ]);
    expect(items[2]).toHaveAttribute('aria-current', 'step');
    expect(await axeViolations(container)).toEqual([]);
  });
});
