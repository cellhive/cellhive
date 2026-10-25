import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The top bar of the app shell holds the page's own header (T320b, design
 * "Grid - Tickets"): the table name, its description and its actions sit in
 * the 52 px bar instead of a band of their own. The shell gives the bar's
 * slot through this context; pages render into it with {@link PageHeader}.
 */
const PageHeaderSlot = createContext<HTMLElement | null>(null);

export const PageHeaderSlotProvider = PageHeaderSlot.Provider;

/** Renders `children` in the shell's top bar (nothing outside the shell). */
export function PageHeader({ children }: { readonly children: ReactNode }) {
  const slot = useContext(PageHeaderSlot);
  return slot === null ? null : createPortal(children, slot);
}
