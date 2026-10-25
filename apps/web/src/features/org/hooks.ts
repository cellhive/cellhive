import { useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { notFound } from '../../lib/navigation/not-found';
import { meQuery } from '../../lib/session/session';

import { workspaceQuery } from './api';

import type { MeOrganization, WorkspaceDto } from '@cellhive/contracts';

/**
 * The organization of `/o/:orgSlug` (the route loader has checked it
 * exists), from the caller's memberships in `GET /me` (CONTRACTS §5A).
 */
export function useRouteOrg(): MeOrganization {
  const { orgSlug } = useParams();
  const { data } = useSuspenseQuery(meQuery());
  const org = data?.orgs.find((item) => item.slug === orgSlug);
  if (org === undefined) notFound();
  return org;
}

/** The workspace of `/o/:orgSlug/w/:workspaceId`. */
export function useRouteWorkspace(org: MeOrganization): WorkspaceDto {
  const { workspaceId } = useParams();
  const { data } = useSuspenseQuery(workspaceQuery(org.id, workspaceId ?? ''));
  return data;
}

export function orgPath(org: Pick<MeOrganization, 'slug'>): string {
  return `/o/${encodeURIComponent(org.slug)}`;
}

export function workspacePath(
  org: Pick<MeOrganization, 'slug'>,
  workspace: Pick<WorkspaceDto, 'id'>,
): string {
  return `${orgPath(org)}/w/${encodeURIComponent(workspace.id)}`;
}

export function basePath(base: { id: string }): string {
  return `/b/${encodeURIComponent(base.id)}`;
}
