import {
  ALLOWLIST_ENTRY_EXISTS,
  HTTP_ALLOWLIST_MAX_ENTRIES,
  INVALID_ALLOWLIST_PATTERN,
  newId,
  parseAllowlistPattern,
  TOO_MANY_ALLOWLIST_ENTRIES,
  type CreateHttpAllowlistEntryRequest,
  type HttpAllowlist,
  type HttpAllowlistEntryDto,
  type Id,
} from '@cellhive/contracts';
import {
  AuditWriter,
  HttpAllowlistRepository,
  OrganizationsRepository,
  orgScope,
  SQLSTATE,
  sqlStateOf,
  type AppConfig,
  type Db,
  type HttpAllowlistListRow,
  type HttpAllowlistRow,
  type JsonObject,
  type OrgScope,
  type Tx,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { type RequestMeta } from '../../common/auth/request-meta.js';
import { iso } from '../../common/dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';

function invalidPattern(code: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path: 'pattern', code, message }],
  });
}

/** Audit snapshot of an entry (CONTRACTS §8). */
function snapshotOf(entry: Pick<HttpAllowlistRow, 'pattern' | 'note'>): JsonObject {
  return { pattern: entry.pattern, note: entry.note };
}

const audit = new AuditWriter();

/**
 * Outbound HTTP allowlist of an organization (BACKLOG T600, CONTRACTS
 * §25.4, ADR-35 §3). Organization owners/admins only: other members `403`,
 * other organizations `404` (an entry of another organization does not
 * exist for the caller). Patterns are host names — exact or `*.suffix` with
 * an optional port — stored in canonical form; IP addresses and CIDR are
 * refused (`INVALID_ALLOWLIST_PATTERN`). Changes are audited
 * (`http_allowlist.created|deleted`, audit only). The SSRF guard reads the
 * entries when an automation calls a URL (`resolveOutboundTarget`).
 */
@Injectable()
export class HttpAllowlistService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(HttpAllowlistRepository) private readonly allowlist: HttpAllowlistRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
  ) {}

  async list(principal: Principal, organizationId: Id<'org'>): Promise<HttpAllowlist> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const rows = await this.allowlist.list(org.scope);
    return {
      items: rows.map((row) => this.dtoOf(row)),
      private_addresses: this.config.outboundHttp.privateAllowlist,
    };
  }

  async create(
    principal: Principal,
    organizationId: Id<'org'>,
    body: CreateHttpAllowlistEntryRequest,
    meta: RequestMeta,
  ): Promise<HttpAllowlistEntryDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const parsed = parseAllowlistPattern(body.pattern);
    if (parsed === null) {
      throw invalidPattern(
        INVALID_ALLOWLIST_PATTERN,
        'Enter a host name (n8n.internal) or *.suffix with at least two labels, ' +
          'optionally with a port; IP addresses and ranges are not accepted.',
      );
    }
    const context = mutationContextOf(meta, principal.userId);
    let created: HttpAllowlistRow;
    try {
      created = await this.db.withTx(async (tx) => {
        // One change at a time per organization: the count and the insert agree.
        await this.organizations.lockById(organizationId, tx);
        const scope = orgScope(organizationId, tx);
        if ((await this.allowlist.count(scope)) >= HTTP_ALLOWLIST_MAX_ENTRIES) {
          throw invalidPattern(
            TOO_MANY_ALLOWLIST_ENTRIES,
            `An organization has at most ${String(HTTP_ALLOWLIST_MAX_ENTRIES)} allowlist entries.`,
          );
        }
        const row = await this.allowlist.create(scope, {
          id: newId('hal'),
          pattern: parsed.pattern,
          host: parsed.host,
          wildcard: parsed.wildcard,
          port: parsed.port,
          note: body.note,
          created_by: principal.userId,
        });
        await this.audit(tx, row, 'http_allowlist.created', context, { after: snapshotOf(row) });
        return row;
      });
    } catch (error) {
      if (sqlStateOf(error) === SQLSTATE.uniqueViolation) {
        throw invalidPattern(ALLOWLIST_ENTRY_EXISTS, 'This host is already in the allowlist.');
      }
      throw error;
    }
    return this.read(org.scope, created.id);
  }

  async remove(principal: Principal, entryId: Id<'hal'>, meta: RequestMeta): Promise<void> {
    const { entry } = await this.requireEntry(principal, entryId);
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = orgScope(entry.organization_id, tx);
      const locked = await this.allowlist.findById(scope, entryId, { forUpdate: true });
      if (locked === undefined) throw notFound();
      await this.allowlist.delete(scope, entryId);
      await this.audit(tx, locked, 'http_allowlist.deleted', context, {
        before: snapshotOf(locked),
      });
    });
  }

  /**
   * The entry in one of the caller's organizations: one of another
   * organization is `404`; a member who is not an owner/admin `403`.
   */
  private async requireEntry(
    principal: Principal,
    entryId: Id<'hal'>,
  ): Promise<{ scope: OrgScope; entry: HttpAllowlistRow }> {
    for (const membership of await this.access.memberships(principal)) {
      const entry = await this.allowlist.findById(orgScope(membership.organizationId), entryId);
      if (entry === undefined) continue;
      const org = await this.access.requireOrgAdmin(principal, membership.organizationId);
      return { scope: org.scope, entry };
    }
    throw notFound();
  }

  private async read(scope: OrgScope, entryId: Id<'hal'>): Promise<HttpAllowlistEntryDto> {
    const row = (await this.allowlist.list(scope)).find((item) => item.id === entryId);
    if (row === undefined) throw notFound();
    return this.dtoOf(row);
  }

  private dtoOf(row: HttpAllowlistListRow): HttpAllowlistEntryDto {
    return {
      id: row.id,
      organization_id: row.organization_id,
      pattern: row.pattern,
      host: row.host,
      wildcard: row.wildcard,
      port: row.port,
      note: row.note,
      created_by:
        row.created_by === null ? null : { id: row.created_by, name: row.created_by_name ?? '' },
      created_at: iso(row.created_at),
    };
  }

  private async audit(
    tx: Tx,
    entry: Pick<HttpAllowlistRow, 'id' | 'organization_id'>,
    action: 'http_allowlist.created' | 'http_allowlist.deleted',
    context: ReturnType<typeof mutationContextOf>,
    values: { readonly before?: JsonObject; readonly after?: JsonObject },
  ): Promise<void> {
    await audit.write(tx, {
      action,
      organizationId: entry.organization_id,
      baseId: null,
      entityType: 'http_allowlist',
      entityId: entry.id,
      before: values.before ?? null,
      after: values.after ?? null,
      context,
    });
  }
}
