import { cn, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  ExternalLink,
  Eye,
  Info,
  Lock,
  ShieldCheck,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { viewsQuery } from '../../../lib/query/queries';
import { rolesQuery } from '../../../lib/query/roles';
import {
  ComputedDependents,
  type ComputedErrorToken,
} from '../../../lib/schema/ComputedDependents';

import type { FieldDependent } from '@cellhive/contracts';

/**
 * Pieces shared by the conversion panes (T414, T415; boards "Đổi kiểu
 * field", "Cấu hình liên kết, bật hai chiều", "Tắt liên kết hai chiều"):
 * counters, the tinted alerts with their consent box, the dependents list.
 */

export type Tone = 'neutral' | 'danger' | 'warning';

const STAT_BORDER: Record<Tone, string> = {
  neutral: 'border-line',
  danger: 'border-danger/40',
  warning: 'border-warning/40',
};
const STAT_VALUE: Record<Tone, string> = {
  neutral: 'text-fg',
  danger: 'text-danger',
  warning: 'text-warning',
};

/** A counter card: big tabular number, what it counts under it. */
export function Stat({
  value,
  label,
  tone = 'neutral',
  'data-testid': testId,
}: {
  value: string;
  label: string;
  tone?: Tone;
  'data-testid'?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-lg border bg-surface px-3 py-2.5',
        STAT_BORDER[tone],
      )}
    >
      <span className={cn('text-[18px] leading-6 font-semibold tabular-nums', STAT_VALUE[tone])}>
        {value}
      </span>
      <span className="text-label font-normal text-fg-muted">{label}</span>
    </div>
  );
}

/** Placeholder of the counters and samples while the first preview loads (no spinner, board S4 states). */
export function PreviewSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-16 rounded-lg" />
        ))}
      </div>
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-7" />
      ))}
    </div>
  );
}

const TINT: Record<Exclude<Tone, 'neutral'> | 'info', string> = {
  danger: 'border-danger/40 bg-danger/5',
  warning: 'border-warning/40 bg-warning/10',
  info: 'border-line bg-surface-sunken',
};
const TINT_ICON: Record<Exclude<Tone, 'neutral'> | 'info', LucideIcon> = {
  danger: TriangleAlert,
  warning: TriangleAlert,
  info: Info,
};

/**
 * A tinted notice of the preview (red: data goes, amber: to know, gray:
 * information), optionally with the check box that must be ticked before
 * the change runs.
 */
export function Notice({
  tone,
  children,
  consent,
  'data-testid': testId,
}: {
  tone: Exclude<Tone, 'neutral'> | 'info';
  children: ReactNode;
  consent?: { label: string; checked: boolean; onChange: (checked: boolean) => void };
  'data-testid'?: string;
}) {
  const Icon = TINT_ICON[tone];
  const id = useId();
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'note'}
      data-testid={testId}
      className={cn('flex flex-col gap-2 rounded-lg border p-3 text-body', TINT[tone])}
    >
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-4 shrink-0',
            tone === 'danger'
              ? 'text-danger'
              : tone === 'warning'
                ? 'text-warning'
                : 'text-fg-muted',
          )}
        />
        <div className="min-w-0 flex-1 [&_strong]:font-semibold">{children}</div>
      </div>
      {consent === undefined ? null : (
        <div className="flex items-center gap-2 pl-6">
          <input
            id={id}
            type="checkbox"
            className="size-4 shrink-0"
            checked={consent.checked}
            onChange={(event) => {
              consent.onChange(event.target.checked);
            }}
          />
          <label htmlFor={id} className="font-medium">
            {consent.label}
          </label>
        </div>
      )}
    </div>
  );
}

/** A value that cannot change (type of a link field, linked table): shown with a lock. */
export function LockedValue({
  icon: Icon,
  children,
  labelledBy,
  describedBy,
  'data-testid': testId,
}: {
  icon?: LucideIcon | undefined;
  children: ReactNode;
  labelledBy: string;
  describedBy?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      role="textbox"
      aria-readonly="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={0}
      data-testid={testId}
      className="flex h-control items-center gap-2 rounded-md border border-line bg-surface-sunken px-3 text-body text-fg-muted"
    >
      {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <Lock aria-hidden="true" className="size-3.5 shrink-0" />
    </div>
  );
}

const DEPENDENT_ICONS: Record<FieldDependent['type'], LucideIcon> = {
  view: Eye,
  role: ShieldCheck,
  field: CircleAlert,
  automation: Workflow,
};

/**
 * What uses the field and may stop working (views, roles; automations once
 * they exist): names from the lists the user can read, a link to open
 * views. (T469) Formula/lookup fields are listed apart with the token their
 * cells will show: `#REF!` when the field goes to the trash, `#VALUE!` when
 * its type change makes their definition invalid (`computedToken`).
 */
export function DependentsList({
  dependents: all,
  tableId,
  baseId,
  title,
  computedToken = '#VALUE!',
}: {
  dependents: readonly FieldDependent[];
  tableId: string;
  baseId: string | undefined;
  title: string;
  computedToken?: ComputedErrorToken;
}) {
  const computed = all.filter((item) => item.type === 'field');
  const dependents = all.filter((item) => item.type !== 'field');
  return (
    <>
      <OtherDependents dependents={dependents} tableId={tableId} baseId={baseId} title={title} />
      <ComputedDependents
        baseId={baseId}
        token={computedToken}
        dependents={computed.map((item) => ({
          id: item.id,
          table_id: item.table_id,
          name: item.name,
        }))}
      />
    </>
  );
}

function OtherDependents({
  dependents,
  tableId,
  baseId,
  title,
}: {
  dependents: readonly FieldDependent[];
  tableId: string;
  baseId: string | undefined;
  title: string;
}) {
  const { t } = useTranslation('field');
  const views = useQuery({
    ...viewsQuery(tableId),
    enabled: dependents.some((item) => item.type === 'view'),
  });
  const roles = useQuery({
    ...rolesQuery(baseId ?? ''),
    enabled: baseId !== undefined && dependents.some((item) => item.type === 'role'),
  });
  if (dependents.length === 0) return null;
  const titleId = `${tableId}-dependents`;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-1.5">
      <h4 id={titleId} className="text-label font-medium text-fg">
        {title}
      </h4>
      <ul
        className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface"
        data-testid="conversion-dependents"
      >
        {dependents.map((dependent) => {
          const Icon = DEPENDENT_ICONS[dependent.type];
          const view =
            dependent.type === 'view'
              ? views.data?.items.find((item) => item.id === dependent.id)
              : undefined;
          const role =
            dependent.type === 'role'
              ? roles.data?.items.find((item) => item.id === dependent.id)
              : undefined;
          const name =
            view?.name ?? role?.name ?? t(`convert.dependents.unnamed.${dependent.type}`);
          return (
            <li
              key={`${dependent.type}:${dependent.id}`}
              className="flex items-center gap-3 px-3 py-2"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body text-fg">{name}</span>
                <span className="text-label font-normal text-fg-muted">
                  {t(`convert.dependents.kinds.${dependent.type}`)}
                </span>
              </span>
              {view !== undefined && baseId !== undefined ? (
                <a
                  href={`/b/${baseId}/t/${tableId}/v/${view.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-control items-center gap-1 text-label text-accent underline underline-offset-2"
                >
                  {t('convert.dependents.open')}
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">{t('convert.dependents.openLabel', { name })}</span>
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
