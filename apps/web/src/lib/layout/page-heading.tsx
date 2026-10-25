import { cn } from '@cellhive/ui';
import { ChevronLeft, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';

import type { ReactNode } from 'react';

export interface PageHeadingProps {
  /** Where "back" goes and its (translated) text, e.g. "Back to Tickets". */
  readonly back?: { readonly to: string; readonly label: string } | undefined;
  readonly icon?: LucideIcon | undefined;
  readonly title: ReactNode;
  /** One line under the title (what the page holds, a retention rule). */
  readonly subtitle?: ReactNode;
  /** Buttons at the end of the title row. */
  readonly actions?: ReactNode;
  /** Under the title, flush with the bottom border: tabs. */
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * The header band of full pages outside the grid — trash, settings (T322b,
 * design "Thùng rác"): back link, title with its icon, subtitle under it
 * (never floating at the far right), actions, optional tabs. Same padding
 * as the page body below it: 16 px on phones, 24 px, 32 px from 1024 px
 * ({@link PAGE_GUTTER}).
 */
export function PageHeading({
  back,
  icon: Icon,
  title,
  subtitle,
  actions,
  children,
  className,
}: PageHeadingProps) {
  return (
    <header
      className={cn(
        'flex flex-col gap-4 border-b border-line bg-surface pt-6',
        PAGE_GUTTER,
        children === undefined ? 'pb-6' : 'pb-0',
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        {back === undefined ? null : (
          <Link
            to={back.to}
            className="inline-flex w-fit items-center gap-1 text-label font-normal text-accent underline-offset-4 hover:underline"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 items-start gap-3">
            {Icon === undefined ? null : (
              <Icon aria-hidden="true" className="mt-1 size-5 shrink-0 text-accent" />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-title break-words">{title}</h1>
              {subtitle === undefined ? null : (
                <p className="text-body text-fg-muted">{subtitle}</p>
              )}
            </div>
          </div>
          {actions === undefined ? null : (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      </div>
      {children}
    </header>
  );
}

/** Side padding shared by a {@link PageHeading} and the body of its page. */
export const PAGE_GUTTER = 'px-4 sm:px-6 lg:px-8';
