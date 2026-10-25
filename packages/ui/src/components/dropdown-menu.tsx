import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { useRef } from 'react';

import { cn } from '../cn';

import type { ComponentProps } from 'react';

/**
 * Dropdown menu (shadcn/ui "dropdown-menu" on Radix, restyled). Non-modal by
 * default: the modal variant locks page scroll by injecting a `<style>`
 * element, which a strict `style-src 'self'` Content Security Policy blocks.
 */
export function DropdownMenu({
  modal = false,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root modal={modal} {...props} />;
}

export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * Whether the focus already sits on something else of the page when a
 * closed menu would give it back to its trigger: an element other than
 * `<body>` (where the focus falls when the menu's own item is removed).
 */
function focusMovedAway(): boolean {
  const active = document.activeElement;
  return active !== null && active !== document.body;
}

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  onCloseAutoFocus,
  onInteractOutside,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  // T420: Radix gives the focus back to the trigger a task after the menu
  // unmounts. A click that lands in between (Escape, then a click on a grid
  // cell) had already focused its target: the trigger then took the focus
  // back, and the next keys (Shift+Space, type to edit) went to the button.
  // The focus stays where that click put it. A close caused by the outside
  // interaction itself keeps Radix's handling (it does not refocus then).
  const interactedOutside = useRef(false);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        onInteractOutside={(event) => {
          interactedOutside.current = true;
          onInteractOutside?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const outside = interactedOutside.current;
          interactedOutside.current = false;
          if (!event.defaultPrevented && !outside && focusMovedAway()) event.preventDefault();
        }}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-48 overflow-y-auto',
          'rounded-lg border border-line bg-surface p-1 text-body text-fg shadow-popover',
          // Short enter (FRONTEND §9.3 motion; reduced motion cuts it). A menu closes at
          // once: it acted, and a fading copy would linger next to the next menu opened.
          'origin-(--radix-dropdown-menu-content-transform-origin) data-[state=open]:animate-pop-in',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

const itemClasses =
  'relative flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 text-body outline-none select-none ' +
  'data-disabled:pointer-events-none data-disabled:opacity-60 data-highlighted:bg-surface-sunken ' +
  '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted';

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={cn(itemClasses, className)} {...props} />;
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(itemClasses, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="text-accent!" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(itemClasses, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center rounded-sm border border-line-control">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="text-accent!" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2 py-1.5 text-label text-fg-muted', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-line', className)}
      {...props}
    />
  );
}
