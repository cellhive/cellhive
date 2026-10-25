import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Suspense, use } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from '../src/index';

function renderDialog(preventDismiss: boolean) {
  const onOpenChange = vi.fn();
  const onDismissBlocked = vi.fn();
  render(
    <Dialog
      open
      onOpenChange={onOpenChange}
      onDismissBlocked={onDismissBlocked}
      preventDismiss={preventDismiss}
      title="Secret"
      closeLabel="Close"
    >
      <p>body</p>
    </Dialog>,
  );
  return { onOpenChange, onDismissBlocked };
}

describe('nested dialogs', () => {
  it('closing a dialog rendered inside another does not close the outer one', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Dialog open onOpenChange={outer} title="Outer" closeLabel="Close outer">
        <Dialog open onOpenChange={inner} title="Inner" closeLabel="Close inner">
          <p>inner</p>
        </Dialog>
      </Dialog>,
    );
    const nested = document.querySelectorAll('dialog')[1];
    if (nested === undefined) throw new Error('no nested dialog');
    fireEvent(nested, new Event('close'));
    expect(inner).toHaveBeenCalledWith(false);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('Dialog dismissal', () => {
  it.each([
    [false, 1, 0],
    [true, 0, 1],
  ])(
    'preventDismiss=%s: the close button calls onOpenChange ×%i, onDismissBlocked ×%i',
    (prevent, closes, blocked) => {
      const { onOpenChange, onDismissBlocked } = renderDialog(prevent);
      fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
      expect(onOpenChange).toHaveBeenCalledTimes(closes);
      expect(onDismissBlocked).toHaveBeenCalledTimes(blocked);
    },
  );

  it.each([
    [false, false, 0],
    [true, true, 1],
  ])(
    'preventDismiss=%s: Escape (cancel event) prevented=%s, onDismissBlocked ×%i',
    (prevent, prevented, blocked) => {
      const { onDismissBlocked } = renderDialog(prevent);
      const dialog = document.querySelector('dialog');
      if (dialog === null) throw new Error('no dialog');
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      expect(cancel.defaultPrevented).toBe(prevented);
      expect(onDismissBlocked).toHaveBeenCalledTimes(blocked);
    },
  );
});

describe('Dialog focus return (WCAG 2.4.3)', () => {
  function Page({ open, mounted }: { open: boolean; mounted: boolean }) {
    return (
      <>
        <button type="button">Opener</button>
        {mounted ? (
          <Dialog open={open} onOpenChange={() => undefined} title="Confirm" closeLabel="Close">
            <input aria-label="Name" />
          </Dialog>
        ) : null}
      </>
    );
  }

  it.each([
    ['unmounted while open', { open: true, mounted: false }],
    ['closed with open=false', { open: false, mounted: true }],
  ])('%s: the focus goes back to the opener', async (_, closed) => {
    const { rerender } = render(<Page open={false} mounted={false} />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    rerender(<Page open mounted />);
    expect(screen.getByRole('textbox', { name: 'Name', hidden: true })).toHaveFocus();
    rerender(<Page {...closed} />);
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('leaves the focus where the caller moved it', async () => {
    const { rerender } = render(<Page open={false} mounted={false} />);
    screen.getByRole('button', { name: 'Opener' }).focus();
    rerender(<Page open mounted />);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    rerender(<Page open mounted={false} />);
    await waitFor(() => {
      expect(elsewhere).toHaveFocus();
    });
    elsewhere.remove();
  });

  // A Suspense boundary that suspends again (a lazy chunk, a suspense query)
  // hides the dialog and runs its layout effect cleanups without unmounting
  // it: the dialog must still be open, and still close, once shown again.
  it('stays open and closable when a Suspense boundary hides and shows it again', async () => {
    let resolve: () => void = () => undefined;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    function Gate({ wait }: { wait: boolean }) {
      if (wait) use(pending);
      return null;
    }
    const onOpenChange = vi.fn();
    function Shell({ wait }: { wait: boolean }) {
      return (
        <Suspense fallback={<p>Loading</p>}>
          <Dialog open onOpenChange={onOpenChange} title="Run" closeLabel="Close">
            <p>detail</p>
          </Dialog>
          <Gate wait={wait} />
        </Suspense>
      );
    }
    const { rerender } = render(<Shell wait={false} />);
    const dialog = document.querySelector('dialog');
    if (dialog === null) throw new Error('no dialog');
    await waitFor(() => {
      expect(dialog.hasAttribute('open')).toBe(true);
    });
    rerender(<Shell wait />);
    expect(await screen.findByText('Loading')).toBeInTheDocument();
    await act(async () => {
      resolve();
      await pending;
    });
    rerender(<Shell wait={false} />);
    await waitFor(() => {
      expect(screen.queryByText('Loading')).toBeNull();
    });
    expect(dialog.hasAttribute('open')).toBe(true);
    fireEvent(dialog, new Event('close'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
