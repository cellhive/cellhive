import { Button, Skeleton } from '@cellhive/ui';
import { Ban, Eye, Info, LayoutDashboard, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../../lib/errors/ErrorAlert';
import { Note } from '../../../parts';
import { canEditDashboards, DASHBOARD_LEVELS, type EditorDashboard } from '../model';

import { Segmented, type SegmentOption } from './Segmented';

import type { RoleKind } from '@cellhive/contracts';
import type { DashboardPerm } from '@cellhive/permissions';

const ICONS: Record<DashboardPerm, LucideIcon> = { read_only: Eye, no_perm: Ban };

export interface DashboardSectionProps {
  readonly kind: RoleKind;
  /** Dashboards of the base outside the trash, in order; `undefined` while loading. */
  readonly dashboards: readonly EditorDashboard[] | undefined;
  readonly error: unknown;
  /** The level of the role on a dashboard (as the server resolves it). */
  readonly levelOf: (dashboardId: string) => DashboardPerm;
  readonly onChange: (dashboardIds: readonly string[], perm: DashboardPerm) => void;
}

/**
 * (T815, FRONTEND §17.4) The dashboards of the base and whether the role
 * reads each one: a two-level `radiogroup` per dashboard (View / No
 * access, as the table levels) and "View all". A custom role reads only
 * the dashboards it lists, so a new dashboard starts at "No access" (deny
 * by default, CONTRACTS §28); the system roles read every dashboard and
 * show it read-only (SPEC §14.1). Widgets still apply the role's table,
 * field and record permissions.
 */
export function DashboardSection({
  kind,
  dashboards,
  error,
  levelOf,
  onChange,
}: DashboardSectionProps) {
  const { t } = useTranslation('baseSettings');
  const id = useId();
  const editable = canEditDashboards(kind);
  const options: SegmentOption<DashboardPerm>[] = DASHBOARD_LEVELS.map((level) => ({
    value: level,
    label: t(`editor.dashboards.levels.${level}`),
    icon: ICONS[level],
  }));
  const hint = editable
    ? 'editor.dashboards.hint'
    : kind === 'system_admin'
      ? 'editor.dashboards.hintAdmin'
      : 'editor.dashboards.hintSystem';

  let body;
  if (error !== null && error !== undefined) {
    body = <ErrorAlert error={error} />;
  } else if (dashboards === undefined) {
    body = <Skeleton className="h-16" data-testid="dashboard-levels-loading" />;
  } else if (dashboards.length === 0) {
    body = (
      <p className="rounded-lg border border-line bg-surface p-4 text-body text-fg-muted">
        {t('editor.dashboards.empty')}
      </p>
    );
  } else {
    const all = dashboards.map((dashboard) => dashboard.id);
    body = (
      <>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="toolbar"
              data-testid="dashboards-read-all"
              disabled={all.every((dashboardId) => levelOf(dashboardId) === 'read_only')}
              onClick={() => {
                onChange(all, 'read_only');
              }}
            >
              <Eye aria-hidden="true" />
              {t('editor.dashboards.readAll')}
            </Button>
            <Button
              variant="secondary"
              size="toolbar"
              data-testid="dashboards-none"
              disabled={all.every((dashboardId) => levelOf(dashboardId) === 'no_perm')}
              onClick={() => {
                onChange(all, 'no_perm');
              }}
            >
              <Ban aria-hidden="true" />
              {t('editor.dashboards.noneAll')}
            </Button>
          </div>
        ) : null}
        <ul
          aria-label={t('editor.dashboards.caption')}
          className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface"
          data-testid="dashboard-levels"
        >
          {dashboards.map((dashboard) => (
            <li
              key={dashboard.id}
              data-testid="dashboard-row"
              data-dashboard-id={dashboard.id}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <span className="flex min-w-0 items-center gap-2 font-medium text-fg">
                <LayoutDashboard aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                <span className="break-words">{dashboard.name}</span>
              </span>
              <Segmented
                className="sm:w-72 sm:shrink-0 sm:grid-cols-2"
                label={t('editor.dashboards.levelOf', { name: dashboard.name })}
                value={levelOf(dashboard.id)}
                options={options}
                disabled={!editable}
                describedBy={editable ? undefined : `${id}-hint`}
                data-testid={`dashboard-level-${dashboard.id}`}
                onChange={(perm) => {
                  onChange([dashboard.id], perm);
                }}
              />
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby={`${id}-title`}
      data-testid="dashboard-section"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id={`${id}-title`} className="text-body font-semibold text-fg">
          {t('editor.dashboards.title')}
        </h2>
        <p id={`${id}-hint`} className="text-label text-fg-muted">
          {t(hint)}
        </p>
      </div>
      {body}
      <Note icon={<Info />} data-testid="dashboard-widgets-note">
        {t('editor.dashboards.widgets')}
      </Note>
    </section>
  );
}
