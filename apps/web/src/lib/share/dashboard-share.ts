import type { BaseDetail, DashboardDto } from '@cellhive/contracts';

/**
 * (T814) "Share" of a dashboard: owned by `features/share/manage`, placed in
 * the dashboard heading by the route (FRONTEND §1.2 — a feature never
 * imports another one).
 */
export interface DashboardShareActionProps {
  readonly dashboard: Pick<DashboardDto, 'id' | 'name' | 'widgets'>;
  readonly base: BaseDetail;
}
