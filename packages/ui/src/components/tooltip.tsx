import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

import { cn } from '../cn';

/**
 * Hover delay before a tooltip shows (keyboard focus shows it at once).
 * Long enough not to flash while the pointer crosses a toolbar, short enough
 * to answer "what is this icon?" (NameThatUI "Tooltip"; Radix default 700 ms).
 */
export const TOOLTIP_DELAY_MS = 400;
/** Moving from one tooltip trigger to the next within this time skips the delay. */
export const TOOLTIP_SKIP_DELAY_MS = 300;

const ProviderPresent = createContext(false);

/** `:focus-visible` (keyboard focus); `true` where the selector is not supported (jsdom). */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Shares the hover delay between the tooltips below it (moving along a
 * toolbar shows the next tooltip at once). Mounted once at the app root;
 * a `Tooltip` outside it brings its own.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={TOOLTIP_DELAY_MS}
      skipDelayDuration={TOOLTIP_SKIP_DELAY_MS}
    >
      <ProviderPresent.Provider value>{children}</ProviderPresent.Provider>
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  /** The short label (already translated). Nothing interactive: tooltips are hints only. */
  content: ReactNode;
  /**
   * The trigger: one focusable element that forwards its ref and props
   * (a `Button`, a link). It keeps its own accessible name (`aria-label`);
   * the tooltip is only its visible form, so it is not announced twice.
   */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** A keyboard shortcut shown after the label, e.g. `⌘Z`. */
  shortcut?: string | undefined;
  /** Controlled open state (tests, tours); leave unset for hover and focus. */
  open?: boolean;
  className?: string;
}

/**
 * Tooltip of an icon-only control (FRONTEND §9.2, T322b): shows on hover
 * after {@link TOOLTIP_DELAY_MS} and at once on keyboard focus, hides on
 * blur, pointer leave and Escape. Replaces the native `title`, which never
 * shows on keyboard focus and cannot be styled. Radix positions it in a
 * portal (no clipping by toolbars) with inline styles only (strict CSP).
 * The enter/exit fade honours `prefers-reduced-motion` (global rule).
 */
export function Tooltip({
  content,
  children,
  side = 'bottom',
  align = 'center',
  shortcut,
  open,
  className,
}: TooltipProps) {
  const hasProvider = useContext(ProviderPresent);
  const tooltip = (
    <TooltipPrimitive.Root {...(open === undefined ? {} : { open })}>
      <TooltipPrimitive.Trigger
        asChild
        // Radix points `aria-describedby` at the content: the name would be read twice.
        aria-describedby={(children.props as { 'aria-describedby'?: string })['aria-describedby']}
        onFocus={(event) => {
          // Focus given back by a menu or popover closed with the mouse: no tooltip.
          if (!focusVisible(event.currentTarget)) event.preventDefault();
        }}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          // The trigger's own name already says it; the content is visual.
          aria-hidden="true"
          className={cn(
            'z-60 flex max-w-64 items-center gap-2 rounded-md bg-inverse px-2 py-1 text-label font-normal text-on-inverse shadow-popover',
            'origin-(--radix-tooltip-content-transform-origin) data-[state=closed]:animate-pop-out',
            'data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-pop-in',
            className,
          )}
        >
          <span>{content}</span>
          {shortcut === undefined ? null : (
            <span className="font-normal text-on-inverse/70">{shortcut}</span>
          )}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return hasProvider ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>;
}
