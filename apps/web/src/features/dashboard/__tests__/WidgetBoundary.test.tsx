import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { WidgetBoundary } from '../widgets/WidgetBoundary';

let broken = true;
function Fragile() {
  if (broken) throw new Error('render failed');
  return <p>Widget</p>;
}

describe('WidgetBoundary (T811)', () => {
  it('shows the fallback of a widget that fails to render, then tries again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <WidgetBoundary
          fallback={(reset) => (
            <button type="button" onClick={reset}>
              Try again
            </button>
          )}
        >
          <Fragile />
        </WidgetBoundary>
        <p>Next widget</p>
      </div>,
    );
    expect(screen.getByText('Next widget')).toBeVisible();
    broken = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Widget')).toBeVisible();
  });
});
