import { useSuspenseQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { baseQuery } from '../../../lib/query/queries';

import { AuditLogPage } from './AuditLogPage';

/**
 * `/b/:baseId/settings/audit` (T716): the entries of one base, for its
 * admins (the `baseSettings` guard of the layout; the API answers `404`
 * to others, and names only fields and tables of this base).
 */
export function BaseAuditLogPage() {
  const { t } = useTranslation('audit');
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const scope = useMemo(
    () => ({ kind: 'base', baseId: base.id, orgId: base.organization_id }) as const,
    [base.id, base.organization_id],
  );
  useDocumentTitle(`${t('page.titleBase')} · ${base.name}`);
  return <AuditLogPage scope={scope} name={base.name} back={`/b/${encodeURIComponent(base.id)}`} />;
}

export default BaseAuditLogPage;
