import { cn } from '@cellhive/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface ToolbarPopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The toggle button, given its ARIA wiring. */
  readonly trigger: (props: {
    readonly 'aria-expanded': boolean;
    readonly 'aria-controls': string;
    readonly 'aria-haspopup': 'dialog';
    readonly onClick: () => void;
    readonly ref: React.Ref<HTMLButtonElement>;
  }) => ReactNode;
  /** Accessible name of the panel. */
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * Keeps the panel mounted while its exit animation runs (T322b motion):
 * `closing` until `animationend`, or at once when nothing animates (reduced
 * motion, jsdom).
 */
function usePresence(open: boolean): { mounted: boolean; closing: boolean; onEnd: () => void } {
  const [closing, setClosing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setClosing(!open && animatesOut());
  }
  return {
    mounted: open || closing,
    closing: !open && closing,
    onEnd: () => {
      setClosing(false);
    },
  };
}

function animatesOut(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  // jsdom has no animations: an `animationend` would never come.
  return typeof window.AnimationEvent === 'function';
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A non-modal panel under a toolbar button (filter, sort) — a bottom sheet
 * on phones (T320b, QA S3: no horizontal overflow at 390 px): the focus moves
 * into it when it opens; Escape closes it and gives the focus back to the
 * button; a click outside closes it. Native controls inside, so everything
 * works with the keyboard (FRONTEND §9.2).
 */
export function ToolbarPopover({
  open,
  onOpenChange,
  trigger,
  label,
  className,
  children,
}: ToolbarPopoverProps) {
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const presence = usePresence(open);

  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapper.current?.contains(target) === true) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={wrapper} className="relative">
      {trigger({
        'aria-expanded': open,
        'aria-controls': panelId,
        'aria-haspopup': 'dialog',
        onClick: () => {
          onOpenChange(!open);
        },
        ref: button,
      })}
      {presence.mounted ? (
        // Phones (< 768 px): a bottom sheet over a dim backdrop, never wider than the screen.
        <div
          aria-hidden="true"
          className={cn(
            'fixed inset-0 z-30 bg-overlay md:hidden',
            presence.closing ? 'pointer-events-none animate-fade-out' : 'animate-fade-in',
          )}
          onClick={() => {
            onOpenChange(false);
            button.current?.focus();
          }}
        />
      ) : null}
      {presence.mounted ? (
        <section
          ref={panel}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label={label}
          tabIndex={-1}
          data-state={presence.closing ? 'closed' : 'open'}
          // Hidden from assistive technology and clicks while it fades out.
          inert={presence.closing}
          aria-hidden={presence.closing || undefined}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && presence.closing) presence.onEnd();
          }}
          className={cn(
            // Sized to its content between a minimum and the screen (T322b).
            'absolute top-full left-0 z-30 mt-1 flex max-h-[70dvh] w-max max-w-[min(42rem,calc(100vw-2rem))] min-w-72 flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-popover',
            'origin-top-left animate-pop-in data-[state=closed]:animate-pop-out',
            className,
            'max-md:fixed max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:z-40 max-md:mt-0 max-md:max-h-[80dvh] max-md:w-full max-md:max-w-none max-md:min-w-0 max-md:rounded-b-none max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))]',
            'max-md:animate-sheet-in max-md:data-[state=closed]:animate-sheet-out',
          )}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(false);
            button.current?.focus();
          }}
        >
          {children}
        </section>
      ) : null}
    </div>
  );
}
