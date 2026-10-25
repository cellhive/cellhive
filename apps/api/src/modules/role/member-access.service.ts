import {
  MEMBER_ACCESS_MAX_COUNTED_TABLES,
  type BasePrincipalList,
  type Id,
  type MemberAccessDto,
  type MemberAccessQuery,
  type PrincipalListQuery,
} from '@cellhive/contracts';
import { explainBaseAccess } from '@cellhive/permissions';
import {
  GroupMembersRepository,
  RecordQueryService,
  UsersRepository,
  type AppConfig,
} from '@cellhive/server-core';
import { isAppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, type BaseAccess } from '../../common/access/access.service.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG } from '../../common/tokens.js';

import {
  decodePrincipalCursor,
  encodePrincipalCursor,
  MemberAccessRepository,
} from './member-access.repository.js';

/** Counts each table up to this many records (`count(*)::int` of `countEditable`). */
const COUNT_CAP = 2_147_483_647;
/** Tables counted at the same time (each count holds one connection; `DATABASE_POOL_MAX` defaults to 10). */
const COUNT_CONCURRENCY = 2;

type Counts = NonNullable<MemberAccessDto['counts']>;

/**
 * Read-only API of the permissions UI (BACKLOG T711, Quyết định S6 #12):
 * the effective access of one member with its source and record counts,
 * and the principals of the role picker. Callers are base admins (the
 * controller's `@RequireBase('admin')`). These are reads of an admin who
 * already sees every record of the base: no audit.
 */
@Injectable()
export class MemberAccessService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(RecordQueryService) private readonly records: RecordQueryService,
    @Inject(MemberAccessRepository) private readonly principals: MemberAccessRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * `userId`'s access to the base, resolved exactly like a request of theirs
   * (`AccessService.resolveForMember`, the path of `GET /bases/:id`), and
   * where it comes from. A user who is not an active member of the base's
   * organization is `404`, like any ID the caller cannot see.
   */
  async memberAccess(
    admin: BaseAccess,
    userId: Id<'usr'>,
    query: MemberAccessQuery,
  ): Promise<MemberAccessDto> {
    const member = await this.access.resolveForMember(
      admin.org.organizationId,
      userId,
      admin.base.id,
    );
    if (member === undefined) throw notFound();
    const user = await this.users.findById(userId);
    if (user === undefined) throw notFound();
    const explained = explainBaseAccess(member.input);
    const access = member.access;
    return {
      user: { id: user.id, display_name: user.display_name },
      access: access?.access ?? null,
      source: {
        kind: explained.kind,
        role_ids: explained.roleIds,
        group_ids: explained.groupIds,
      },
      counts: query.counts && access !== undefined ? await this.counts(user, access) : null,
    };
  }

  /**
   * Live records the member reads and edits in the first visible tables,
   * each counted by `RecordQueryService` with the member's access under its
   * statement timeout; a table whose count times out is `null`.
   */
  private async counts(
    user: Parameters<typeof recordAccessContextOf>[1],
    access: BaseAccess,
  ): Promise<Counts> {
    const context = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      user,
      access,
    );
    const tableIds = (Object.keys(access.access.tables) as Id<'tbl'>[]).slice(
      0,
      MEMBER_ACCESS_MAX_COUNTED_TABLES,
    );
    const counts: Counts = {};
    for (let start = 0; start < tableIds.length; start += COUNT_CONCURRENCY) {
      const chunk = tableIds.slice(start, start + COUNT_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (tableId) => {
          try {
            const counted = await this.records.countEditable(
              access.org.scope,
              tableId,
              context,
              null,
              COUNT_CAP,
            );
            return {
              readable: counted.editable + counted.notEditable,
              editable: counted.editable,
            };
          } catch (error) {
            if (isAppError(error) && error.code === 'QUERY_TIMEOUT') {
              this.logger.warn(
                { base_id: access.base.id, table_id: tableId },
                'member access count timed out',
              );
              return null;
            }
            throw error;
          }
        }),
      );
      chunk.forEach((tableId, index) => {
        counts[tableId] = results[index] ?? null;
      });
    }
    return counts;
  }

  /**
   * Active members and groups of the base's organization, by name, each
   * with its role in the base (`null` = none). Cursor pagination.
   */
  async listPrincipals(admin: BaseAccess, query: PrincipalListQuery): Promise<BasePrincipalList> {
    const rows = await this.principals.listPrincipals(admin.org.scope, admin.base.id, {
      search: query.q ?? null,
      cursor: decodePrincipalCursor(query.cursor),
      limit: query.limit,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        principal_type: row.principal_type,
        principal_id: row.principal_id,
        name: row.name,
        email: row.email,
        role_id: row.role_id,
        full_access: row.full_access,
      })),
      next_cursor:
        rows.length > query.limit && last !== undefined
          ? encodePrincipalCursor({
              key: last.sort_key,
              type: last.principal_type,
              id: last.principal_id,
            })
          : null,
    };
  }
}
