import { cn } from '@cellhive/ui';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ActorAvatar, EntityText, ViaLabels } from './labels';

import type { ActorLabel, EntityLabel, ViaLabel } from '../model';
import type { AuditLogEntryDto } from '@cellhive/contracts';
import type { KeyboardEvent } from 'react';

/** One entry as the list shows it (names resolved by the page). */
export interface AuditRow {
  readonly entry: AuditLogEntryDto;
  readonly time: string;
  readonly actor: ActorLabel;
  readonly actorText: string;
  readonly via: readonly ViaLabel[];
  readonly action: string;
  readonly entity: EntityLabel;
  readonly entityText: string;
  /** Organization page: the base's name (`null`: an organization-level entry). */
  readonly base: string | null;
}

export interface AuditListProps {
  readonly rows: readonly AuditRow[];
  /** Organization page: a "Base" column. */
  readonly showBase: boolean;
  readonly narrow: boolean;
  readonly onOpen: (row: AuditRow, opener: HTMLElement) => void;
}

const TH = 'h-9 px-3 text-left text-label font-medium whitespace-nowrap text-fg-muted';
const TD = 'px-3 py-1.5 align-top';

/** ArrowUp/ArrowDown (and Home/End) move between the entries' buttons. */
function onRowKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-audit-open]')];
  const index = buttons.indexOf(event.target as HTMLElement);
  if (index === -1) return;
  const next =
    event.key === 'ArrowDown'
      ? Math.min(index + 1, buttons.length - 1)
      : event.key === 'ArrowUp'
        ? Math.max(index - 1, 0)
        : event.key === 'Home'
          ? 0
          : buttons.length - 1;
  event.preventDefault();
  buttons[next]?.focus();
}

function Actor({ row }: { row: AuditRow }) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      <ActorAvatar actor={row.actor} className="mt-px" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0 break-words text-fg" data-testid="audit-actor">
          {row.actorText}
        </span>
        <ViaLabels via={row.via} />
      </span>
    </span>
  );
}

/**
 * The entries, newest first (T716): a dense table (rows ~36 px) from 768 px
 * — time (the button that opens the details), who (avatar, name, "via …"),
 * action, object, base (organization page) — and cards below.
 */
export function AuditList({ rows, showBase, narrow, onOpen }: AuditListProps) {
  const { t } = useTranslation('audit');
  const openLabel = (row: AuditRow) => t('list.open', { action: row.action, time: row.time });

  if (narrow) {
    return (
      <ul
        aria-label={t('page.caption')}
        className="flex flex-col gap-2"
        data-testid="audit-cards"
        onKeyDown={onRowKeyDown}
      >
        {rows.map((row) => (
          <li
            key={row.entry.id}
            data-testid="audit-row"
            data-entry-id={row.entry.id}
            className="relative flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
          >
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0 font-medium break-words text-fg">{row.action}</span>
              <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
            </span>
            <Actor row={row} />
            <EntityText entity={row.entity} />
            <span className="flex flex-wrap gap-x-3 text-label font-normal text-fg-muted">
              <time dateTime={row.entry.created_at}>{row.time}</time>
              {showBase && row.base !== null ? <span>{row.base}</span> : null}
            </span>
            {/* The whole card opens the details; the button stretches over it. */}
            <button
              type="button"
              data-audit-open=""
              className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={openLabel(row)}
              onClick={(event) => {
                onOpen(row, event.currentTarget);
              }}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table
        className="w-full border-collapse text-body"
        data-testid="audit-table"
        onKeyDown={onRowKeyDown}
      >
        <caption className="sr-only">{t('page.caption')}</caption>
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className={TH}>
              {t('columns.time')}
            </th>
            <th scope="col" className={TH}>
              {t('columns.actor')}
            </th>
            <th scope="col" className={TH}>
              {t('columns.action')}
            </th>
            <th scope="col" className={TH}>
              {t('columns.object')}
            </th>
            {showBase ? (
              <th scope="col" className={TH}>
                {t('columns.base')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr
              key={row.entry.id}
              data-testid="audit-row"
              data-entry-id={row.entry.id}
              className="hover:bg-surface-sunken"
            >
              <td className={cn(TD, 'w-0 whitespace-nowrap')}>
                <button
                  type="button"
                  data-audit-open=""
                  className="-mx-1 inline-flex min-h-6 items-center rounded-sm px-1 text-left text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label={openLabel(row)}
                  onClick={(event) => {
                    onOpen(row, event.currentTarget);
                  }}
                >
                  <time dateTime={row.entry.created_at}>{row.time}</time>
                </button>
              </td>
              <td className={cn(TD, 'min-w-48')}>
                <Actor row={row} />
              </td>
              <td className={cn(TD, 'min-w-40 break-words')}>{row.action}</td>
              <td className={cn(TD, 'min-w-48')}>
                <EntityText entity={row.entity} />
              </td>
              {showBase ? (
                <td className={cn(TD, 'min-w-32 break-words text-fg-muted')}>
                  {row.base ?? t('object.none')}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
