import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '../cn';

import { Button } from './button';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Accessible name of the close button (translated by the caller). */
  closeLabel: string;
  className?: string;
  /**
   * `sheet`: below 768 px the dialog is a bottom sheet (full width, at the
   * bottom edge, rising in) — for long forms whose footer must stay in reach.
   * `drawer`: from 768 px a full-height panel at the right edge (sliding in),
   * below a bottom sheet — for forms beside the list they edit.
   */
  layout?: 'center' | 'sheet' | 'drawer';
  /** `alertdialog`: a confirmation of a destructive action (WAI-ARIA alert dialog). */
  role?: 'dialog' | 'alertdialog';
  /**
   * Escape and the close button do not close the dialog; they call
   * {@link DialogProps.onDismissBlocked} instead (e.g. a secret shown once:
   * the user confirms it was saved first). The browser may still force a
   * close after repeated Escape presses: `onOpenChange(false)` then runs.
   */
  preventDismiss?: boolean;
  /** Escape or the close button was used while {@link DialogProps.preventDismiss} is set. */
  onDismissBlocked?: () => void;
  children?: ReactNode;
}

/** Longest exit transition (tokens.css `--motion-exit`) plus a margin. */
const EXIT_MS = 200;

/** Whether the dialog has an exit transition to wait for (not in jsdom, not with reduced motion). */
function animates(dialog: HTMLDialogElement): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const duration = window.getComputedStyle(dialog).transitionDuration;
  return duration !== '' && duration.split(',').some((part) => Number.parseFloat(part) > 0);
}

/**
 * Gives the focus back to `opener` (WCAG 2.4.3) when it is still in `dialog`
 * or lost (`<body>`): a caller that has already moved it keeps it.
 */
function restoreFocus(dialog: HTMLDialogElement, opener: HTMLElement | null): void {
  const active = document.activeElement;
  const lost = active === null || active === document.body || dialog.contains(active);
  if (lost && opener?.isConnected === true) opener.focus();
}

/**
 * Modal dialog on the native `<dialog>` element: the browser moves focus
 * into it, makes the rest of the page inert and closes it on Escape. Unlike
 * the Radix dialog it needs no injected `<style>` (strict CSP, FRONTEND §12).
 * It fades and scales in and out (`dialog[data-motion]` in the app's CSS,
 * FRONTEND §9.3 motion), or rises as a bottom sheet on phones (`layout`).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  className,
  layout = 'center',
  role,
  preventDismiss = false,
  onDismissBlocked,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  /** What had the focus when the dialog opened: it gets it back on close. */
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  // The content stays while the dialog fades out (T322b motion), then goes.
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setClosing(false);
    }, EXIT_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [closing]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // jsdom lacks showModal; the attribute keeps tests meaningful.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      // The browser focuses the first focusable element (the close button);
      // start in the first form control instead, as users expect.
      dialog
        .querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea')
        ?.focus();
    } else if (!open && dialog.open) {
      // The browser gives the focus back on `close()`; jsdom has neither.
      if (typeof dialog.close === 'function') {
        dialog.close();
        if (animates(dialog)) setClosing(true);
      } else {
        dialog.removeAttribute('open');
        restoreFocus(dialog, opener.current);
      }
    }
  }, [open]);

  // Unmounted while open (`{open ? <Dialog open …/> : null}`, the usual way to
  // close one): the browser does not restore the focus of a modal dialog
  // removed from the page, it falls to `<body>`. Once React has removed it
  // (the page is no longer inert), the opener gets it back. The dialog itself
  // is left alone: a layout cleanup also runs when a Suspense boundary only
  // hides the dialog (still in the page, still open), not just on unmount.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog === null) return;
      const from = opener.current;
      queueMicrotask(() => {
        if (!dialog.isConnected) restoreFocus(dialog, from);
      });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      data-motion={layout}
      // React propagates `cancel`/`close` of a dialog nested in the React tree
      // (a confirmation opened from a drawer) up to this one: only our own count.
      onCancel={(event) => {
        if (event.target !== event.currentTarget || !preventDismiss) return;
        event.preventDefault();
        onDismissBlocked?.();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        onOpenChange(false);
      }}
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-line bg-surface p-0 text-fg shadow-popover',
        'backdrop:bg-overlay',
        className,
        layout === 'drawer' &&
          'md:my-0 md:mr-0 md:ml-auto md:h-dvh md:max-h-none md:w-[480px] md:max-w-[480px] md:rounded-none md:border-y-0 md:border-r-0',
        layout !== 'center' &&
          'max-md:mx-0 max-md:mt-auto max-md:mb-0 max-md:max-h-[calc(100dvh-2rem)] max-md:w-full max-md:max-w-none max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0',
      )}
    >
      {open || closing ? (
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-heading text-fg">
                {title}
              </h2>
              {description === undefined ? null : (
                <p id={descriptionId} className="text-body text-fg-muted">
                  {description}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={closeLabel}
              onClick={() => {
                if (preventDismiss) onDismissBlocked?.();
                else onOpenChange(false);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
