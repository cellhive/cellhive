import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderApp, stubApi } from '../../../../test/app-harness';

describe('SetupPage', () => {
  it('validates each field with translated messages and keeps values in their fields', async () => {
    stubApi({ setupRequired: true });
    await renderApp('/setup');
    const user = userEvent.setup();
    const submit = await screen.findByRole('button', { name: 'Create account and organization' });
    await user.click(submit);
    expect(await screen.findAllByText('Required.')).toHaveLength(4);
    expect(screen.getByLabelText('Your name')).toHaveFocus();

    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(submit);
    expect(await screen.findByText('Must be at least 10 characters.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveValue('short');
    expect(screen.getByLabelText('Your name')).toHaveValue('');
  });
});
