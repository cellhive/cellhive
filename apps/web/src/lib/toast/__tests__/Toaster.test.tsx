import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../api/client';
import {
  clearToasts,
  DEFAULT_TOAST_MS,
  MAX_TOASTS,
  showErrorToast,
  showToast,
  updateToast,
} from '../toast';
import { Toaster } from '../Toaster';

import type { i18n as I18n } from 'i18next';

let i18n: I18n;

beforeAll(async () => {
  i18n = await createTestI18n('en');
});

afterEach(() => {
  act(() => {
    clearToasts();
  });
  vi.useRealTimers();
});

function renderToaster() {
  return render(
    <I18nextProvider i18n={i18n}>
      <Toaster />
    </I18nextProvider>,
  );
}

const conflict = new ApiError({
  status: 409,
  code: 'VERSION_CONFLICT',
  errors: [{ path: 'records[0]', code: 'VERSION_CONFLICT', message: 'x' }],
  request_id: 'req_0123456789ABCDEF',
});

describe('Toaster (FRONTEND §8.1)', () => {
  it('lives in a labelled region and announces info politely', () => {
    renderToaster();
    act(() => {
      showToast({ message: 'Saved.' });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(within(region).getByRole('status')).toHaveTextContent('Saved.');
  });

  it('translates an API error with its details and a shortened, copyable request ID', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderToaster();
    act(() => {
      showErrorToast(conflict);
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Someone else changed this in the meantime.');
    expect(alert).toHaveTextContent('Someone else changed this record in the meantime.');
    expect(alert).toHaveTextContent('req_01234567…');
    expect(alert).not.toHaveTextContent('req_0123456789ABCDEF');
    await userEvent.click(within(alert).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('req_0123456789ABCDEF');
    expect(within(alert).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('re-translates when the language changes', async () => {
    const vi18n = await createTestI18n('en');
    render(
      <I18nextProvider i18n={vi18n}>
        <Toaster />
      </I18nextProvider>,
    );
    act(() => {
      showErrorToast(new ApiError({ status: 404, code: 'NOT_FOUND' }));
    });
    await act(async () => {
      await vi18n.changeLanguage('vi');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Không tìm thấy');
  });

  it('shows a title, labelled values and a primary action (conflict, FRONTEND §4.1)', async () => {
    const writeMine = vi.fn();
    const { container } = renderToaster();
    act(() => {
      showToast({
        title: 'Changed by someone else',
        message: 'An changed “Status” while you were editing it.',
        details: [
          { label: 'Their value', value: 'Done' },
          { label: 'Your value', value: 'Doing' },
        ],
        actions: [
          { label: 'Keep their value', onClick: () => undefined },
          { label: 'Write my value', onClick: writeMine, primary: true },
        ],
      });
    });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Changed by someone else');
    expect(within(status).getByText('Their value').nextElementSibling).toHaveTextContent('Done');
    expect(within(status).getByText('Your value').nextElementSibling).toHaveTextContent('Doing');
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(within(status).getByRole('button', { name: 'Write my value' }));
    expect(writeMine).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dismisses info toasts after a delay, but keeps errors', () => {
    vi.useFakeTimers();
    renderToaster();
    act(() => {
      showToast({ message: 'Saved.' });
      showErrorToast(conflict);
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_MS + 1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('pauses the timer while hovered', () => {
    vi.useFakeTimers();
    renderToaster();
    act(() => {
      showToast({ message: 'Saved.' });
    });
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_MS * 2);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_MS + 1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('closes with the dismiss button and with Escape', async () => {
    renderToaster();
    act(() => {
      showErrorToast(conflict);
      showToast({ message: 'Second', durationMs: null });
    });
    await userEvent.click(
      within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss notification' }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const status = screen.getByRole('status');
    within(status).getByRole('button', { name: 'Dismiss notification' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('runs an action and closes the toast', async () => {
    const retry = vi.fn();
    renderToaster();
    act(() => {
      showErrorToast(conflict, { actions: [{ label: 'Write mine', onClick: retry }] });
    });
    await userEvent.click(screen.getByRole('button', { name: 'Write mine' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it(`keeps at most ${String(MAX_TOASTS)} toasts, dropping the oldest`, () => {
    renderToaster();
    act(() => {
      for (let index = 0; index < MAX_TOASTS + 2; index++) {
        showToast({ message: `Toast ${String(index)}`, durationMs: null });
      }
    });
    const items = screen.getAllByRole('status');
    expect(items).toHaveLength(MAX_TOASTS);
    expect(items[0]).toHaveTextContent('Toast 2');
  });

  it('shows job progress and replaces it with the outcome (updateToast)', () => {
    vi.useFakeTimers();
    renderToaster();
    let id = 0;
    act(() => {
      id = showToast({ message: 'Removing options', progress: 0.25, durationMs: null });
    });
    expect(screen.getByRole('progressbar', { name: 'Removing options' })).toHaveAttribute(
      'aria-valuenow',
      '25',
    );
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_MS * 2);
    });
    expect(screen.getByText('Removing options')).toBeInTheDocument();
    act(() => {
      updateToast(id, { variant: 'success', message: 'Options removed' });
    });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('Options removed')).toBeInTheDocument();
    // The outcome is an ordinary toast again: it goes after the delay.
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_MS);
    });
    expect(screen.queryByText('Options removed')).not.toBeInTheDocument();
    expect(updateToast(id, { message: 'gone' })).toBe(false);
  });

  it('has no serious accessibility violations', async () => {
    const { container } = renderToaster();
    act(() => {
      showToast({ message: 'Saved.', variant: 'success' });
      showErrorToast(conflict, { actions: [{ label: 'Retry', onClick: () => undefined }] });
    });
    expect(await axeViolations(container)).toEqual([]);
  });
});
