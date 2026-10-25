import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { notFound } from '../../../lib/navigation/not-found';
import { meQuery } from '../../../lib/session/session';

import { AuditLogPage } from './AuditLogPage';

/**
 * `/o/:orgSlug/settings/audit` (T716): the organization's audit log, for
 * owners and admins (the `orgSettings` guard of the layout; the API answers
 * `404` to others).
 */
export function OrgAuditLogPage() {
  const { t } = useTranslation('audit');
  const { orgSlug } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const scope = useMemo(
    () => (org === undefined ? null : ({ kind: 'org', orgId: org.id } as const)),
    [org],
  );
  useDocumentTitle(org === undefined ? undefined : `${t('page.titleOrg')} · ${org.name}`);
  if (me.data !== undefined && org === undefined) notFound();
  if (org === undefined || scope === null) return null;
  return <AuditLogPage scope={scope} name={org.name} back={`/o/${encodeURIComponent(org.slug)}`} />;
}

export default OrgAuditLogPage;
