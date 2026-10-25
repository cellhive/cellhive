import { AuditWriter } from '../audit/audit-writer.js';

import type { AuditEntryInput } from '../audit/audit-entry.js';
import type { Tx } from '../db/create-db.js';
import type { OrganizationsRepository } from '../db/repositories/organizations.repository.js';
import type { Id } from '@cellhive/contracts';

/**
 * Writes an audit entry about a user once per organization the user belongs
 * to, so each organization's admins see it in their audit log; with no
 * organization (unknown email, user without membership) one entry with
 * `organization_id = NULL` (allowed for `auth.*` and system actors only,
 * CONTRACTS §8).
 */
export async function auditForUser(
  tx: Tx,
  organizations: OrganizationsRepository,
  userId: Id<'usr'> | null,
  entry: Omit<AuditEntryInput, 'organizationId'>,
  audit: AuditWriter = new AuditWriter(),
): Promise<void> {
  const memberships = userId === null ? [] : await organizations.listMembershipsOfUser(userId, tx);
  if (memberships.length === 0) {
    await audit.write(tx, { ...entry, organizationId: null });
    return;
  }
  for (const membership of memberships) {
    await audit.write(tx, { ...entry, organizationId: membership.organizationId });
  }
}
