import {
  LAST_VIEW,
  MAX_PERSONAL_VIEWS_PER_TABLE,
  MAX_VIEW_NAME_LENGTH,
  MAX_VIEWS_PER_TABLE,
  newId,
  VIEW_LIMIT_EXCEEDED,
  VIEW_LOCKED,
  type CreateViewRequest,
  type DuplicateViewRequest,
  type Id,
  type OffsetQuery,
  type StoredViewConfig,
  type UpdateViewRequest,
  type ViewDto,
  type ViewList,
} from '@cellhive/contracts';
import { isViewVisible, type TableAccess } from '@cellhive/permissions';
import {
  activeFieldIds,
  BaseRolesRepository,
  BasesRepository,
  buildViewConfig,
  configJson,
  copyViewConfig,
  FieldsRepository,
  FormCoversRepository,
  isComputedRow,
  loadBaseSchemaRows,
  lockedComputedFieldIds,
  orgScope,
  publishViewChanged,
  restrictViewConfig,
  storedViewConfigOf,
  strictComputedPermissionsOf,
  ViewsRepository,
  visibleFieldIds,
  withTxScope,
  type AuditContext,
  type Db,
  type JsonObject,
  type OrgScope,
  type Tx,
  type ViewConfigContext,
  type ViewGroup,
  type ViewLinkTarget,
  type ViewRow,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
} from '../../common/access/access.service.js';
import { mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { iso, validationFailed } from '../../common/dto.js';
import { canManageTable, SchemaAccess } from '../../common/schema/schema-access.js';
import { DB } from '../../common/tokens.js';
import { readabilityOf } from '../field/computed-fields.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/** A view the caller can see, with the access that makes it visible. */
interface LocatedView {
  readonly base: BaseAccess;
  readonly tableAccess: TableAccess;
  readonly view: ViewRow;
}

/** What the caller may do with shared views of a table (SPEC §8, §14.1). */
function canEditSharedViews(base: BaseAccess, tableId: Id<'tbl'>): boolean {
  return (
    canManageTable(base.access, tableId) ||
    base.access.tables[tableId]?.view_rule.allow_edit === true
  );
}

/** `options.link_table` of a link field row; `null` when absent. */
function linkTableOf(options: unknown): string | null {
  if (typeof options !== 'object' || options === null) return null;
  const value = (options as Record<string, unknown>)['link_table'];
  return typeof value === 'string' ? value : null;
}

function groupOf(view: Pick<ViewRow, 'owner_id'>): ViewGroup {
  return { ownerId: view.owner_id };
}

function nameConflict(): AppError {
  return new AppError('NAME_CONFLICT', {
    detail: 'A view with this name already exists in the table.',
    errors: [{ path: 'name', code: 'NAME_CONFLICT', message: 'The view name is already used' }],
    params: { kind: 'view' },
  });
}

function limitExceeded(scope: 'table' | 'personal'): AppError {
  const limit = scope === 'table' ? MAX_VIEWS_PER_TABLE : MAX_PERSONAL_VIEWS_PER_TABLE;
  return validationFailed(
    scope === 'table'
      ? `A table can have at most ${String(limit)} views.`
      : `A user can have at most ${String(limit)} personal views on a table.`,
    { path: '', code: VIEW_LIMIT_EXCEEDED, params: { limit, scope } },
  );
}

/** A new cover that is not a ready cover the saver uploaded for a form of this table (T419). */
function coverNotFound(): AppError {
  return validationFailed('The cover image does not exist or is not yours.', {
    path: 'config.form.cover_attachment_id',
    code: 'ATTACHMENT_NOT_FOUND',
  });
}

function viewLocked(path: string): AppError {
  return validationFailed('The view is locked; unlock it first.', { path, code: VIEW_LOCKED });
}

function lastView(path: string): AppError {
  return validationFailed('A table must keep at least one shared view.', {
    path,
    code: LAST_VIEW,
  });
}

/** Moves `id` to `index` (clamped) in `ids`; `null` when it is already there or absent. */
function reorder<T extends string>(ids: readonly T[], id: T, index: number): T[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = Math.min(Math.max(index, 0), ids.length - 1);
  if (from === to) return null;
  const order = ids.filter((candidate) => candidate !== id);
  order.splice(to, 0, id);
  return order;
}

/** Audit/event snapshot of a view. */
function snapshotOf(view: ViewRow): JsonObject {
  return {
    id: view.id,
    table_id: view.table_id,
    type: view.type,
    name: view.name,
    is_personal: view.is_personal,
    owner_id: view.owner_id,
    position: view.position,
    locked: view.locked,
    config: view.config,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Saved views (SPEC §8, CONTRACTS §15; BACKLOG T301).
 *
 * - Seeing a view: the table is readable and the view is shared and in
 *   `view_rule.visible_views` (`null` = all), or is the caller's personal
 *   view. Anything else — a hidden view, someone else's personal view — is
 *   `404`, and never listed.
 * - Shared views: creating, changing and deleting need `view_rule.allow_edit`
 *   or schema rights on the table (`403` otherwise); locking needs schema
 *   rights. A locked view's config cannot change (`VIEW_LOCKED`).
 * - Personal views: anyone who reads the table creates them (50 per user
 *   and table); only the owner sees and changes them.
 * - Every change writes `view.*` + audit in its transaction and publishes
 *   `schema.changed` (entity `view`) once committed, to the subscribers who
 *   can see the view. Removing a shared view (delete, or making it
 *   personal) also removes it from every role's `visible_views` and bumps
 *   `permission_version`.
 */
@Injectable()
export class ViewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(BaseRolesRepository) private readonly roles: BaseRolesRepository,
    @Inject(FormCoversRepository) private readonly covers: FormCoversRepository,
  ) {}

  async list(principal: Principal, tableId: Id<'tbl'>, query: OffsetQuery): Promise<ViewList> {
    const { base } = await this.schemaAccess.requireTable(principal, tableId, 'read');
    const tableAccess = this.tableAccessOf(base, tableId);
    const rows = (await this.views.listByTable(base.org.scope, tableId, principal.userId)).filter(
      (view) => view.is_personal || isViewVisible(tableAccess, view.id),
    );
    const context = await this.contextOf(base, tableId, tableAccess);
    return {
      items: rows
        .slice(query.offset, query.offset + query.limit)
        .map((view) => this.dtoOf(view, context)),
      total: rows.length,
      offset: query.offset,
      limit: query.limit,
    };
  }

  async get(principal: Principal, viewId: Id<'viw'>): Promise<ViewDto> {
    const found = await this.locate(principal, viewId);
    return this.dtoOf(
      found.view,
      await this.contextOf(found.base, found.view.table_id, found.tableAccess),
    );
  }

  async create(
    principal: Principal,
    tableId: Id<'tbl'>,
    input: CreateViewRequest,
    meta: RequestMeta,
  ): Promise<ViewDto> {
    const { base } = await this.schemaAccess.requireTable(principal, tableId, 'read');
    const tableAccess = this.tableAccessOf(base, tableId);
    if (!input.is_personal && !canEditSharedViews(base, tableId)) {
      throw permissionDenied('Creating shared views needs view editing rights on the table.');
    }
    const context = await this.contextOf(base, tableId, tableAccess);
    const config = buildViewConfig(input.type, input.config ?? {}, context, null);
    const ownerId = input.is_personal ? principal.userId : null;
    const auditContext = mutationContextOf(meta, principal.userId);
    const view = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.views.lockTable(scope, tableId);
      await this.assertCapacity(scope, tableId, ownerId);
      if (await this.views.nameTaken(scope, tableId, { ownerId }, input.name)) throw nameConflict();
      await this.checkCover(scope, tableId, principal.userId, null, config);
      const created = await this.views.insert(scope, {
        id: newId('viw'),
        tableId,
        type: input.type,
        name: input.name,
        config: configJson(config),
        position: await this.views.nextPosition(scope, tableId, { ownerId }),
        ownerId,
      });
      await this.recordView(tx, base, created, 'view.created', auditContext, {
        after: snapshotOf(created),
      });
      await this.publish(tx, base, created, 'created');
      return created;
    });
    return this.dtoOf(view, context);
  }

  async update(
    principal: Principal,
    viewId: Id<'viw'>,
    input: UpdateViewRequest,
    meta: RequestMeta,
  ): Promise<ViewDto> {
    const found = await this.locate(principal, viewId);
    const { base, tableAccess } = found;
    const tableId = found.view.table_id;
    const canEditShared = canEditSharedViews(base, tableId);
    const becomesPersonal = input.is_personal === true && !found.view.is_personal;
    const becomesShared = input.is_personal === false && found.view.is_personal;

    // Permissions first (403), then state (422).
    if (!found.view.is_personal && !canEditShared) {
      throw permissionDenied('Changing shared views needs view editing rights on the table.');
    }
    if (becomesShared && !canEditShared) {
      throw permissionDenied('Sharing a view needs view editing rights on the table.');
    }
    if (input.locked !== undefined && input.locked !== found.view.locked) {
      if (input.locked && (found.view.is_personal || becomesPersonal)) {
        throw validationFailed('Only shared views can be locked.', {
          path: 'locked',
          code: 'NOT_ALLOWED',
        });
      }
      if (!canManageTable(base.access, tableId)) {
        throw permissionDenied('Locking views needs schema rights on the table.');
      }
    }

    const context = await this.contextOf(base, tableId, tableAccess);
    const auditContext = mutationContextOf(meta, principal.userId);
    const converts = becomesPersonal || becomesShared;
    const result = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      // Role changes read the shared views under the base lock (RoleService).
      if (becomesPersonal) await this.lockBase(scope, base);
      await this.views.lockTable(scope, tableId);
      const current = await this.views.lockById(scope, viewId);
      if (current === undefined) throw notFound();
      const locked = input.locked ?? current.locked;
      if (locked && (input.config !== undefined || converts)) {
        throw viewLocked(input.config !== undefined ? 'config' : 'is_personal');
      }

      const type = current.type;
      const stored = storedViewConfigOf(type, current.config);
      let ownerId = current.owner_id;
      let config: StoredViewConfig = stored;
      let position: number | undefined;
      if (converts) {
        ownerId = becomesPersonal ? principal.userId : null;
        const counts = await this.views.counts(scope, tableId, ownerId);
        if (becomesPersonal) {
          if (counts.shared <= 1) throw lastView('is_personal');
          if (counts.personal >= MAX_PERSONAL_VIEWS_PER_TABLE) throw limitExceeded('personal');
        }
        config = copyViewConfig(type, stored, context);
        position = await this.views.nextPosition(scope, tableId, { ownerId });
      }
      if (input.config !== undefined) {
        config = buildViewConfig(type, input.config, context, config);
        await this.checkCover(
          scope,
          tableId,
          principal.userId,
          stored.form?.cover_attachment_id ?? null,
          config,
        );
      }
      const name = input.name ?? current.name;
      if (
        (converts || name !== current.name) &&
        (await this.views.nameTaken(scope, tableId, { ownerId }, name, viewId))
      ) {
        throw nameConflict();
      }

      const changed =
        !sameJson(config, stored) || name !== current.name || converts || locked !== current.locked;
      let updated = current;
      if (changed) {
        const next = await this.views.update(scope, viewId, {
          ...(name === current.name ? {} : { name }),
          ...(sameJson(config, stored) ? {} : { config: configJson(config) }),
          ...(converts ? { ownerId, position: position ?? 0, locked: false } : {}),
          ...(!converts && locked !== current.locked ? { locked } : {}),
        });
        if (next === undefined) throw notFound();
        updated = next;
      }
      if (input.position !== undefined) {
        const siblings = await this.views.listGroup(scope, tableId, groupOf(updated));
        const order = reorder(
          siblings.map((view) => view.id),
          viewId,
          input.position,
        );
        if (order !== null) {
          await this.views.setPositions(
            scope,
            tableId,
            order.map((id, index) => ({ id, position: index })),
          );
          updated = (await this.views.getById(scope, viewId)) ?? updated;
        }
      }
      const before = snapshotOf(current);
      const after = snapshotOf(updated);
      const keys = Object.keys(after).filter((key) => !sameJson(before[key], after[key]));
      if (keys.length === 0) return { view: updated, changedRoles: false };

      await this.recordView(tx, base, updated, 'view.updated', auditContext, {
        before: Object.fromEntries(keys.map((key) => [key, before[key] ?? null])),
        after: Object.fromEntries(keys.map((key) => [key, after[key] ?? null])),
        changed: keys,
      });
      let changedRoles = false;
      if (becomesPersonal) {
        changedRoles = await this.removeFromRoles(tx, scope, base, current, auditContext);
      }
      if (converts) {
        // The view leaves one audience and joins another.
        await this.publish(tx, base, current, 'deleted');
        await this.publish(tx, base, updated, 'created');
      } else {
        await this.publish(tx, base, updated, 'updated');
      }
      return { view: updated, changedRoles };
    });
    if (result.changedRoles) this.access.invalidate(principal);
    return this.dtoOf(result.view, context);
  }

  async delete(principal: Principal, viewId: Id<'viw'>, meta: RequestMeta): Promise<void> {
    const found = await this.locate(principal, viewId);
    const { base } = found;
    const tableId = found.view.table_id;
    if (!found.view.is_personal && !canEditSharedViews(base, tableId)) {
      throw permissionDenied('Deleting shared views needs view editing rights on the table.');
    }
    const auditContext = mutationContextOf(meta, principal.userId);
    const changedRoles = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      if (!found.view.is_personal) await this.lockBase(scope, base);
      await this.views.lockTable(scope, tableId);
      const current = await this.views.lockById(scope, viewId);
      if (current === undefined) throw notFound();
      if (current.locked) throw viewLocked('');
      if (!current.is_personal) {
        const counts = await this.views.counts(scope, tableId, null);
        if (counts.shared <= 1) throw lastView('');
      }
      if ((await this.views.delete(scope, viewId)) === undefined) throw notFound();
      await this.recordView(tx, base, current, 'view.deleted', auditContext, {
        before: snapshotOf(current),
      });
      const rolesChanged = current.is_personal
        ? false
        : await this.removeFromRoles(tx, scope, base, current, auditContext);
      await this.publish(tx, base, current, 'deleted');
      return rolesChanged;
    });
    if (changedRoles) this.access.invalidate(principal);
  }

  async duplicate(
    principal: Principal,
    viewId: Id<'viw'>,
    input: DuplicateViewRequest,
    meta: RequestMeta,
  ): Promise<ViewDto> {
    const found = await this.locate(principal, viewId);
    const { base, tableAccess } = found;
    const tableId = found.view.table_id;
    const personal = input.is_personal ?? found.view.is_personal;
    if (!personal && !canEditSharedViews(base, tableId)) {
      throw permissionDenied('Creating shared views needs view editing rights on the table.');
    }
    const type = found.view.type;
    const context = await this.contextOf(base, tableId, tableAccess);
    const config = copyViewConfig(type, storedViewConfigOf(type, found.view.config), context);
    const ownerId = personal ? principal.userId : null;
    const auditContext = mutationContextOf(meta, principal.userId);
    const view = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      await this.views.lockTable(scope, tableId);
      await this.assertCapacity(scope, tableId, ownerId);
      const name = await this.copyName(scope, tableId, { ownerId }, found.view.name, input.name);
      const created = await this.views.insert(scope, {
        id: newId('viw'),
        tableId,
        type,
        name,
        config: configJson(config),
        position: await this.views.nextPosition(scope, tableId, { ownerId }),
        ownerId,
      });
      await this.recordView(tx, base, created, 'view.created', auditContext, {
        after: snapshotOf(created),
        duplicatedFrom: found.view.id,
      });
      await this.publish(tx, base, created, 'created');
      return created;
    });
    return this.dtoOf(view, context);
  }

  /**
   * A form view the caller can see (else `404`) and may change the config of
   * (`403` otherwise; locked: `422 VIEW_LOCKED`; not a form: `422
   * NOT_ALLOWED`): who may upload its cover image (T419).
   */
  async locateEditableForm(
    principal: Principal,
    viewId: Id<'viw'>,
  ): Promise<{ readonly base: BaseAccess; readonly view: ViewRow }> {
    const found = await this.locate(principal, viewId);
    if (!found.view.is_personal && !canEditSharedViews(found.base, found.view.table_id)) {
      throw permissionDenied('Changing shared views needs view editing rights on the table.');
    }
    if (found.view.locked) throw viewLocked('');
    if (found.view.type !== 'form') {
      throw validationFailed('Only form views have a cover image.', {
        path: '',
        code: 'NOT_ALLOWED',
      });
    }
    return { base: found.base, view: found.view };
  }

  /** A view the caller can see, else `404` (the cover image of a form, T419). */
  async locateVisible(
    principal: Principal,
    viewId: Id<'viw'>,
  ): Promise<{ readonly base: BaseAccess; readonly view: ViewRow }> {
    const found = await this.locate(principal, viewId);
    return { base: found.base, view: found.view };
  }

  // ---------------------------------------------------------------------------

  /**
   * A new `form.cover_attachment_id` (T419, CONTRACTS §15) must be a `ready`
   * cover the saver uploaded for a form of this table; an unchanged one is
   * kept as it is (duplicates, other keys saved). The row is locked
   * `FOR SHARE` so that the cleanup cannot delete it under the save.
   */
  private async checkCover(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    userId: Id<'usr'>,
    previous: string | null,
    config: StoredViewConfig,
  ): Promise<void> {
    const next = config.form?.cover_attachment_id ?? null;
    if (next === null || next === previous) return;
    const cover = await this.covers.lockShared(scope, next as Id<'att'>);
    if (cover?.status !== 'ready' || cover.table_id !== tableId || cover.created_by !== userId) {
      throw coverNotFound();
    }
  }

  /**
   * A view the caller can see: its table is readable, and it is their
   * personal view or a shared view in `visible_views`. Anything else is
   * `404`, like a missing view.
   */
  private async locate(principal: Principal, viewId: Id<'viw'>): Promise<LocatedView> {
    for (const membership of await this.access.memberships(principal)) {
      const view = await this.views.getById(orgScope(membership.organizationId), viewId);
      if (view === undefined) continue;
      const { base } = await this.schemaAccess.requireTable(principal, view.table_id, 'read');
      const tableAccess = this.tableAccessOf(base, view.table_id);
      const visible = view.is_personal
        ? view.owner_id === principal.userId
        : isViewVisible(tableAccess, view.id);
      if (!visible) throw notFound();
      return { base, tableAccess, view };
    }
    throw notFound();
  }

  private tableAccessOf(base: BaseAccess, tableId: Id<'tbl'>): TableAccess {
    const tableAccess = base.access.tables[tableId];
    // `requireTable` already answered 404 for tables without access.
    if (tableAccess === undefined) throw notFound();
    return tableAccess;
  }

  /**
   * Active fields of the table and the ones the caller can read; for each
   * link field, the active fields of its linked table and the ones the caller
   * reads there (`record_detail.link_columns`, T402).
   */
  private async contextOf(
    base: BaseAccess,
    tableId: Id<'tbl'>,
    tableAccess: TableAccess,
  ): Promise<ViewConfigContext> {
    const scope = base.org.scope;
    const rows = await this.fields.listByTable(scope, tableId);
    const linkTargets = new Map<string, ViewLinkTarget>();
    const byTable = new Map<string, ViewLinkTarget>();
    for (const field of rows) {
      if (field.type !== 'link') continue;
      const linkTable = linkTableOf(field.options);
      if (linkTable === null) continue;
      let target = byTable.get(linkTable);
      if (target === undefined) {
        const access = base.access.tables[linkTable as Id<'tbl'>];
        const perm: string | undefined = access?.perm;
        const readable =
          access === undefined || perm === 'no_perm'
            ? new Set<string>()
            : new Set(
                Object.entries(access.fields)
                  .filter(([, fieldPerm]) => (fieldPerm as string) !== 'no_perm')
                  .map(([id]) => id),
              );
        const fields =
          readable.size === 0
            ? []
            : (await this.fields.listByTable(scope, linkTable as Id<'tbl'>)).map((item) => ({
                id: item.id,
              }));
        target = { fields, readable };
        byTable.set(linkTable, target);
      }
      linkTargets.set(field.id, target);
    }
    // Formula/lookup fields (T457): filters/sorts follow their result type;
    // locked ones answer like hidden fields.
    const locked = rows.some(isComputedRow)
      ? lockedComputedFieldIds(
          await loadBaseSchemaRows(this.db, scope, base.base.id),
          tableId,
          readabilityOf(base.access),
          strictComputedPermissionsOf(base.base.settings),
        )
      : new Set<string>();
    return {
      fields: rows.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        options: field.options,
        required: field.required,
        ...(isComputedRow(field) ? { result_type: field.result_type } : {}),
      })),
      readable: new Set(Object.keys(tableAccess.fields)),
      linkTargets,
      locked,
    };
  }

  private dtoOf(view: ViewRow, context: ViewConfigContext): ViewDto {
    const type = view.type;
    const config = restrictViewConfig(
      storedViewConfigOf(type, view.config),
      visibleFieldIds(context),
      activeFieldIds(context),
      context.linkTargets,
      context.fields,
    );
    return {
      id: view.id,
      table_id: view.table_id,
      type,
      name: view.name,
      is_personal: view.is_personal,
      owner_id: view.owner_id,
      position: view.position,
      locked: view.locked,
      config: config as ViewDto['config'],
      created_at: iso(view.created_at),
      updated_at: iso(view.updated_at),
    };
  }

  private async lockBase(scope: OrgScope, base: BaseAccess): Promise<number> {
    const locked = await this.bases.lockForUpdate(scope, base.base.id);
    if (locked === undefined) throw notFound();
    return Number(locked.permission_version);
  }

  private async assertCapacity(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    ownerId: Id<'usr'> | null,
  ): Promise<void> {
    const counts = await this.views.counts(scope, tableId, ownerId);
    if (counts.total >= MAX_VIEWS_PER_TABLE) throw limitExceeded('table');
    if (ownerId !== null && counts.personal >= MAX_PERSONAL_VIEWS_PER_TABLE) {
      throw limitExceeded('personal');
    }
  }

  /** `requested`, or the first free `<source> copy`, `<source> copy 2`, … */
  private async copyName(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    group: ViewGroup,
    source: string,
    requested: string | undefined,
  ): Promise<string> {
    if (requested !== undefined) {
      if (await this.views.nameTaken(scope, tableId, group, requested)) throw nameConflict();
      return requested;
    }
    for (let attempt = 1; attempt <= MAX_VIEWS_PER_TABLE + 1; attempt += 1) {
      const suffix = attempt === 1 ? ' copy' : ` copy ${String(attempt)}`;
      const name = `${source.slice(0, MAX_VIEW_NAME_LENGTH - suffix.length)}${suffix}`;
      if (!(await this.views.nameTaken(scope, tableId, group, name))) return name;
    }
    throw nameConflict();
  }

  /**
   * Removes a shared view from `visible_views` of every role of the base
   * (in the caller's transaction, base row locked): each changed role gets
   * `role.updated`, and the base `permission_version` is bumped once with
   * `permission.changed`. Returns whether any role changed.
   */
  private async removeFromRoles(
    tx: Tx,
    scope: OrgScope,
    base: BaseAccess,
    view: ViewRow,
    context: AuditContext,
  ): Promise<boolean> {
    let changed = false;
    for (const role of await this.roles.listByBase(scope, base.base.id)) {
      const config = role.config as {
        tables?: Record<string, { view_rule?: { visible_views?: string[] | null } }>;
      };
      const rule = config.tables?.[view.table_id]?.view_rule;
      const visible = rule?.visible_views;
      if (rule === undefined || !Array.isArray(visible) || !visible.includes(view.id)) continue;
      const nextVisible = visible.filter((id) => id !== view.id);
      const nextConfig = structuredClone(role.config) as typeof config;
      const nextRule = nextConfig.tables?.[view.table_id]?.view_rule;
      if (nextRule !== undefined) nextRule.visible_views = nextVisible;
      await this.roles.update(scope, base.base.id, role.id, {
        config: nextConfig,
      });
      await recordChange(tx, {
        type: 'role.updated',
        organizationId: base.org.organizationId,
        baseId: base.base.id,
        entityType: 'role',
        entityId: role.id,
        context,
        before: { config: role.config },
        after: { config: nextConfig as unknown as JsonObject },
        data: { name: role.name, kind: role.kind, changed: ['config'], removed_view_id: view.id },
      });
      changed = true;
    }
    if (!changed) return false;
    const locked = await this.lockBase(scope, base);
    await this.bases.bumpPermissionVersion(scope, { baseIds: [base.base.id] });
    await recordChange(tx, {
      type: 'permission.changed',
      organizationId: base.org.organizationId,
      baseId: base.base.id,
      entityType: 'base',
      entityId: base.base.id,
      context,
      before: { permission_version: locked },
      after: { permission_version: locked + 1 },
      data: { permission_version: locked + 1 },
    });
    return true;
  }

  private async recordView(
    tx: Tx,
    base: BaseAccess,
    view: ViewRow,
    type: 'view.created' | 'view.updated' | 'view.deleted',
    context: AuditContext,
    change: {
      readonly before?: JsonObject;
      readonly after?: JsonObject;
      readonly changed?: readonly string[];
      readonly duplicatedFrom?: Id<'viw'>;
    },
  ): Promise<void> {
    await recordChange(tx, {
      type,
      organizationId: base.org.organizationId,
      baseId: base.base.id,
      tableId: view.table_id,
      entityType: 'view',
      entityId: view.id,
      context,
      before: change.before ?? null,
      after: change.after ?? null,
      data: {
        table_id: view.table_id,
        type: view.type,
        name: view.name,
        is_personal: view.is_personal,
        ...(change.changed === undefined ? {} : { changed: [...change.changed] }),
        ...(change.duplicatedFrom === undefined ? {} : { duplicated_from: change.duplicatedFrom }),
      },
    });
  }

  private async publish(
    tx: Tx,
    base: BaseAccess,
    view: ViewRow,
    action: 'created' | 'updated' | 'deleted',
  ): Promise<void> {
    await publishViewChanged(this.db, tx, {
      organizationId: base.org.organizationId,
      baseId: base.base.id,
      tableId: view.table_id,
      viewId: view.id,
      ownerId: view.owner_id,
      action,
    });
  }
}
