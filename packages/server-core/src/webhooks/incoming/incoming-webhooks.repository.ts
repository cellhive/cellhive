import { sql, type Insertable, type Updateable } from 'kysely';

import {
  afterCursor,
  cursorTimestamp,
  pageWithCursor,
  type KeysetCursor,
} from '../../db/cursor.js';
import { jsonb } from '../../db/json.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type {
  IncomingWebhookRequestRow,
  IncomingWebhookRequestsTable,
  IncomingWebhookRow,
  IncomingWebhooksTable,
  JsonValue,
} from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

export type NewIncomingWebhook = Omit<
  Insertable<IncomingWebhooksTable>,
  'organization_id' | 'created_at' | 'updated_at' | 'deleted_at'
>;

/** What the management API may change (credentials included; never ids or the base). */
export type IncomingWebhookPatch = Pick<
  Updateable<IncomingWebhooksTable>,
  | 'name'
  | 'enabled'
  | 'rate_limit_per_sec'
  | 'auth'
  | 'token_hash'
  | 'token_enc'
  | 'signing_secret_enc'
  | 'signing_secret_prev_enc'
  | 'signing_secret_prev_expires_at'
  | 'bearer_hash'
>;

/** A hook with the name of who created it (`null` when that member left). */
export type IncomingWebhookListRow = IncomingWebhookRow & {
  readonly created_by_name: string | null;
  /** Newest request row still stored (kept 7 days, duplicates included), `null` without one. */
  readonly last_received_at: Date | null;
};

/**
 * `meta.incoming_webhooks` (BACKLOG T602, ADR-35 §1). Every query is scoped
 * by `organization_id`: a hook of another organization behaves exactly like
 * a missing one. Soft-deleted hooks are left out unless asked for. The
 * public route's token lookup is the cross-tenant
 * `findIncomingWebhookByTokenHash` (`db/cross-tenant-lookups.ts`), which
 * returns ids only; the hook is then read here with its organization.
 */
export class IncomingWebhooksRepository
  extends TenantRepository<'incoming_webhooks'>
  implements TenantRepositoryContract<IncomingWebhooksRepository>
{
  constructor(db: Db) {
    super(db, 'incoming_webhooks');
  }

  async create(scope: OrgScope, input: NewIncomingWebhook): Promise<IncomingWebhookRow> {
    return this.executor(scope)
      .insertInto('meta.incoming_webhooks')
      .values({ ...input, organization_id: scope.organizationId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(
    scope: OrgScope,
    id: Id<'hok'>,
    options: { readonly forUpdate?: boolean; readonly includeDeleted?: boolean } = {},
  ): Promise<IncomingWebhookRow | undefined> {
    let query = this.executor(scope)
      .selectFrom('meta.incoming_webhooks')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id);
    if (options.includeDeleted !== true) query = query.where('deleted_at', 'is', null);
    if (options.forUpdate === true) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Live hooks of a base, oldest first, with their creator's name. */
  async listByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<IncomingWebhookListRow[]> {
    return this.listRows(scope, { baseId });
  }

  /** One live hook with its creator's name. */
  async findListRow(scope: OrgScope, id: Id<'hok'>): Promise<IncomingWebhookListRow | undefined> {
    const [row] = await this.listRows(scope, { id });
    return row;
  }

  /** Live hooks of a base (the 50-per-base cap). */
  async countByBase(scope: OrgScope, baseId: Id<'bse'>): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.incoming_webhooks')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('base_id', '=', baseId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Applies `patch` to a live hook; `undefined` when there is none. */
  async update(
    scope: OrgScope,
    id: Id<'hok'>,
    patch: IncomingWebhookPatch,
  ): Promise<IncomingWebhookRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.incoming_webhooks')
      .set(patch)
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Soft delete: the hook disappears from every read and the public route,
   * its sample and listening window are dropped; the token hash stays
   * reserved (never reused).
   */
  async softDelete(scope: OrgScope, id: Id<'hok'>): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.incoming_webhooks')
      .set({
        deleted_at: sql<Date>`now()`,
        enabled: false,
        listen_until: null,
        listened_by: null,
        sample: null,
        sample_captured_at: null,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Opens (or replaces) the "listen for a sample request" window of a live
   * hook until `until`, for `userId`, and drops the previous sample.
   * `undefined` when there is no live hook.
   */
  async startListening(
    scope: OrgScope,
    id: Id<'hok'>,
    userId: Id<'usr'>,
    until: Date,
  ): Promise<IncomingWebhookRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.incoming_webhooks')
      .set({ listen_until: until, listened_by: userId, sample: null, sample_captured_at: null })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Closes the listening window of a live hook (a captured sample stays); `false` when none. */
  async stopListening(scope: OrgScope, id: Id<'hok'>): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.incoming_webhooks')
      .set({ listen_until: null, listened_by: null })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Stores `sample()` (built only then) when the hook's listening window is open and closes the
   * window. Run in a transaction (`scope.tx`): the row lock makes concurrent
   * requests wait, and once the first one committed the others find the
   * window closed — only the first valid request becomes the sample.
   * Returns the member who was listening (`null` when that member left), or
   * `undefined` when no window was open.
   */
  async captureSample(
    scope: OrgScope,
    id: Id<'hok'>,
    sample: () => JsonValue,
  ): Promise<{ readonly listenedBy: Id<'usr'> | null } | undefined> {
    const open = await this.executor(scope)
      .selectFrom('meta.incoming_webhooks')
      .select('listened_by')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .where('listen_until', '>', sql<Date>`now()`)
      .forUpdate()
      .executeTakeFirst();
    if (open === undefined) return undefined;
    await this.executor(scope)
      .updateTable('meta.incoming_webhooks')
      .set({
        sample: jsonb(sample()),
        sample_captured_at: sql<Date>`now()`,
        listen_until: null,
        listened_by: null,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .execute();
    return { listenedBy: open.listened_by };
  }

  private async listRows(
    scope: OrgScope,
    filter: { readonly baseId?: Id<'bse'>; readonly id?: Id<'hok'> },
  ): Promise<IncomingWebhookListRow[]> {
    let query = this.executor(scope)
      .selectFrom('meta.incoming_webhooks as h')
      .leftJoin('meta.users as u', 'u.id', 'h.created_by')
      .selectAll('h')
      .select('u.display_name as created_by_name')
      // T616: one index probe per hook (`incoming_webhook_requests_hook_idx`, received_at DESC).
      .select((eb) =>
        eb
          .selectFrom('meta.incoming_webhook_requests as r')
          .select((sub) => sub.fn.max('r.received_at').as('at'))
          .whereRef('r.organization_id', '=', 'h.organization_id')
          .whereRef('r.incoming_webhook_id', '=', 'h.id')
          .as('last_received_at'),
      )
      .where('h.organization_id', '=', scope.organizationId)
      .where('h.deleted_at', 'is', null);
    if (filter.baseId !== undefined) query = query.where('h.base_id', '=', filter.baseId);
    if (filter.id !== undefined) query = query.where('h.id', '=', filter.id);
    return query.orderBy('h.created_at').orderBy('h.id').execute();
  }
}

/** A row of the request log: metadata only. */
export type IncomingWebhookRequestLogRow = Pick<
  IncomingWebhookRequestRow,
  'id' | 'received_at' | 'size_bytes' | 'duplicate' | 'causation_accepted' | 'event_id'
>;

export interface NewIncomingWebhookRequest {
  readonly id: Id<'whr'>;
  readonly incomingWebhookId: Id<'hok'>;
  readonly messageId: string | null;
  readonly body: JsonValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, JsonValue>>;
  readonly sizeBytes: number;
  readonly causationAccepted: boolean;
  readonly eventId: Id<'evt'> | null;
  /** Default: now. */
  readonly receivedAt?: Date;
}

/**
 * `meta.incoming_webhook_requests` (BACKLOG T602, ADR-35 §1): raw requests
 * of a hook, kept 7 days. The management API reads the log (metadata only);
 * the public route (T603) inserts, deduplicating on `webhook-id`.
 */
export class IncomingWebhookRequestsRepository
  extends TenantRepository<'incoming_webhook_requests'>
  implements TenantRepositoryContract<IncomingWebhookRequestsRepository>
{
  constructor(db: Db) {
    super(db, 'incoming_webhook_requests');
  }

  /**
   * Stores a request. With a `messageId` already stored for the hook, nothing
   * is written and `undefined` is returned (a replay: `202`, no event).
   */
  async insert(
    scope: OrgScope,
    input: NewIncomingWebhookRequest,
  ): Promise<IncomingWebhookRequestRow | undefined> {
    const values: Insertable<IncomingWebhookRequestsTable> = {
      id: input.id,
      organization_id: scope.organizationId,
      incoming_webhook_id: input.incomingWebhookId,
      message_id: input.messageId,
      body: input.body === null ? null : jsonb(input.body),
      headers: jsonb(input.headers as JsonValue),
      query: jsonb(input.query as JsonValue),
      size_bytes: input.sizeBytes,
      causation_accepted: input.causationAccepted,
      event_id: input.eventId,
      ...(input.receivedAt === undefined ? {} : { received_at: input.receivedAt }),
    };
    return this.executor(scope)
      .insertInto('meta.incoming_webhook_requests')
      .values(values)
      .onConflict((oc) =>
        oc.columns(['organization_id', 'incoming_webhook_id', 'message_id']).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Logs a replayed `webhook-id` (CONTRACTS §25.1 `duplicate`): no message
   * id, body, headers, query or event — only when and how big.
   */
  async insertDuplicate(
    scope: OrgScope,
    input: {
      readonly id: Id<'whr'>;
      readonly incomingWebhookId: Id<'hok'>;
      readonly sizeBytes: number;
      readonly receivedAt?: Date;
    },
  ): Promise<IncomingWebhookRequestRow> {
    return this.executor(scope)
      .insertInto('meta.incoming_webhook_requests')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        incoming_webhook_id: input.incomingWebhookId,
        message_id: null,
        body: null,
        size_bytes: input.sizeBytes,
        duplicate: true,
        causation_accepted: false,
        event_id: null,
        ...(input.receivedAt === undefined ? {} : { received_at: input.receivedAt }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async findById(scope: OrgScope, id: Id<'whr'>): Promise<IncomingWebhookRequestRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.incoming_webhook_requests')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** The log of a hook, newest first (`received_at DESC, id DESC`), cursor-paginated. */
  async listPage(
    scope: OrgScope,
    incomingWebhookId: Id<'hok'>,
    page: { readonly cursor: KeysetCursor | null; readonly limit: number },
  ): Promise<{ items: IncomingWebhookRequestLogRow[]; nextCursor: string | null }> {
    let query = this.executor(scope)
      .selectFrom('meta.incoming_webhook_requests')
      .select(['id', 'received_at', 'size_bytes', 'duplicate', 'causation_accepted', 'event_id'])
      .select(cursorTimestamp(sql`received_at`).as('cursor_at'))
      .where('organization_id', '=', scope.organizationId)
      .where('incoming_webhook_id', '=', incomingWebhookId);
    if (page.cursor !== null) {
      query = query.where(afterCursor(sql`received_at`, sql`id`, page.cursor));
    }
    const rows = await query
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const { items, nextCursor } = pageWithCursor(rows, page.limit, (row) => ({
      at: row.cursor_at,
      id: row.id,
    }));
    return {
      items: items.map((row) => ({
        id: row.id,
        received_at: row.received_at,
        size_bytes: row.size_bytes,
        duplicate: row.duplicate,
        causation_accepted: row.causation_accepted,
        event_id: row.event_id,
      })),
      nextCursor,
    };
  }
}
