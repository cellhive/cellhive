import {
  actorTypeSchema,
  eventBatchSchema,
  eventTypeSchema,
  eventViaSchema as contractEventViaSchema,
  idOf,
  type ActorType,
  type EventBatch,
  type EventType,
  type EventVia,
  type Id,
} from '@cellhive/contracts';
import { z } from 'zod';

import type { JsonObject, JsonValue } from '../db/schema.js';

/**
 * Internal events (`meta.events`, CONTRACTS §8). Services emit one per
 * mutation, in the mutation's transaction; `events.dispatch` hands them to
 * automations after commit.
 */

/** Who caused something (CONTRACTS §8 `actor`). `id` is `null` only for `system`. */
export interface Actor {
  readonly type: ActorType;
  readonly id: string | null;
}

/** Loop guard data (SPEC §11.6). */
export interface Causation {
  readonly root_event_id: Id<'evt'>;
  readonly depth: number;
  readonly automation_chain: readonly Id<'aut'>[];
}

/** What a service passes to `EventWriter.write` / `emit`. */
export interface EventInput {
  readonly type: EventType;
  readonly organizationId: Id<'org'>;
  /** Defaults to the part of `type` before the verb, e.g. `record` for `record.updated`. */
  readonly entityType?: string;
  readonly entityId: string;
  readonly actor: Actor;
  readonly baseId?: Id<'bse'> | null;
  readonly tableId?: Id<'tbl'> | null;
  /** Storage-form values only (option ids, user ids, record ids), never formatted. */
  readonly changes?: Readonly<Record<string, { readonly from: JsonValue; readonly to: JsonValue }>>;
  readonly recordVersion?: number;
  /** Other event-specific data. Must not contain secrets. */
  readonly data?: JsonObject;
  /** Set by automations (`childCausation`); user mutations leave it out (depth 0). */
  readonly causation?: Causation;
  /**
   * `record.*` (ADR-26 §1): the request/job/run of the change and how many
   * records that call changed. Absent = a single change.
   */
  readonly batch?: EventBatch;
  /**
   * Where the change came from besides the actor, as in the audit entry
   * (ADR-23); recomputed values add `computed_recompute`/`job_id` (T509).
   */
  readonly via?: EventVia;
}

/** The event as documented in CONTRACTS §8. */
export interface EventDocument {
  readonly id: Id<'evt'>;
  readonly type: EventType;
  readonly organization_id: Id<'org'>;
  readonly base_id?: Id<'bse'>;
  readonly table_id?: Id<'tbl'>;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor: Actor;
  readonly changes?: Readonly<Record<string, { readonly from: JsonValue; readonly to: JsonValue }>>;
  readonly record_version?: number;
  readonly data?: JsonObject;
  readonly causation: Causation;
  readonly batch?: EventBatch;
  readonly via?: EventVia;
  readonly created_at: string;
}

/** Deepest causation depth any organization may configure (SPEC §11.6). */
export const MAX_CAUSATION_DEPTH = 5;

/**
 * Longest `automation_chain`: a chain grows by one per depth, but causations
 * merged through the recompute queue (T509: union of chains) can name more
 * automations than the depth.
 */
export const MAX_CAUSATION_CHAIN = 64;

const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine(Number.isFinite, 'must be a finite number'),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const actorSchema = z
  .object({ type: actorTypeSchema, id: z.string().min(1).max(64).nullable() })
  .strict()
  .refine((actor) => actor.type === 'system' || actor.id !== null, {
    message: 'actor.id is required unless actor.type is system',
    path: ['id'],
  });

export const causationSchema = z
  .object({
    root_event_id: idOf('evt'),
    depth: z.number().int().min(0).max(MAX_CAUSATION_DEPTH),
    automation_chain: z.array(idOf('aut')).max(MAX_CAUSATION_CHAIN),
  })
  .strict();

/**
 * `via` of an event: the audit `via` (ADR-23, CONTRACTS §11.1), plus
 * `computed_recompute`/`job_id` of recomputed values (T509, CONTRACTS §8).
 */
export const eventViaSchema = contractEventViaSchema;

export const eventInputSchema = z
  .object({
    type: eventTypeSchema,
    organizationId: idOf('org'),
    entityType: z.string().regex(ENTITY_TYPE_PATTERN).optional(),
    entityId: z.string().min(1).max(128),
    actor: actorSchema,
    baseId: idOf('bse').nullable().optional(),
    tableId: idOf('tbl').nullable().optional(),
    changes: z
      .record(z.string().min(1), z.object({ from: jsonValueSchema, to: jsonValueSchema }).strict())
      .optional(),
    recordVersion: z.number().int().min(0).optional(),
    data: z.record(z.string(), jsonValueSchema).optional(),
    causation: causationSchema.optional(),
    batch: eventBatchSchema.optional(),
    via: eventViaSchema.optional(),
  })
  .strict();

/**
 * Entity type of an event from its name: `record.updated` → `record`,
 * `automation.run.failed` → `automation_run`.
 */
export function entityTypeOf(type: EventType): string {
  const parts = type.split('.');
  return parts.slice(0, -1).join('_');
}

/** Causation of an event written by `automationId` while handling `parent` (SPEC §11.6). */
export function childCausation(
  parent: Pick<EventDocument, 'id' | 'causation'>,
  automationId: Id<'aut'>,
): Causation {
  return {
    root_event_id: parent.causation.root_event_id,
    depth: parent.causation.depth + 1,
    automation_chain: [...parent.causation.automation_chain, automationId],
  };
}

/**
 * The causation an outbound HTTP call of a run carries in its
 * `X-Cellhive-Causation` token (ADR-27 §2), from the causation of the run's
 * writes (`childCausation` of its trigger): the same chain — the run's
 * automation included — at the run's own depth. The hook that receives the
 * token adds the hop (`depth + 1`), so A → hook → B costs one level, like
 * A → record → B (review fix 2026-10-25: the token used to carry the
 * writes' depth and the hook added one more, two levels per hop).
 */
export function outboundHttpCausation(writes: Causation): Causation {
  return { ...writes, depth: Math.max(0, writes.depth - 1) };
}

/**
 * Conservative merge of two causations (T509, S4b-decisions-followup §3.4):
 * rows of the recompute queue merge the writes that queued them, so the
 * loop guard must see the deepest depth and every automation of every
 * chain. `root_event_id` stays the first one's; `undefined` is "unknown"
 * and leaves the other. Same rule as `meta.merge_recompute_causation`
 * (migration 0030). The chain keeps at most `MAX_CAUSATION_CHAIN` ids.
 */
export function mergeCausations(
  a: Causation | undefined,
  b: Causation | undefined,
): Causation | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const chain = [...a.automation_chain];
  for (const id of b.automation_chain) if (!chain.includes(id)) chain.push(id);
  return {
    root_event_id: a.root_event_id,
    depth: Math.max(a.depth, b.depth),
    automation_chain: chain.slice(0, MAX_CAUSATION_CHAIN),
  };
}

/** Columns of `meta.events` for a validated input (without `created_at`, set by the database). */
export interface EventRowValues {
  readonly id: Id<'evt'>;
  readonly organization_id: Id<'org'>;
  readonly type: EventType;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor_type: ActorType;
  readonly actor_id: string | null;
  readonly payload: JsonObject;
  readonly causation: Causation;
}

/**
 * Validates `input` and builds the row. The type must be in the closed
 * catalogue (CONTRACTS §8); anything else is a programming error
 * (`TypeError`), never stored. `payload` holds the event-specific part of the
 * CONTRACTS §8 document (`base_id`, `table_id`, `changes`, `record_version`,
 * `data`); the rest lives in columns.
 */
export function buildEventRow(input: EventInput, id: Id<'evt'>): EventRowValues {
  const parsed = eventInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TypeError(
      `Invalid event: ${issue === undefined ? 'unknown error' : `${issue.path.join('.') || '(root)'}: ${issue.message}`}`,
    );
  }
  const event = parsed.data;
  const payload: JsonObject = {};
  if (event.baseId != null) payload.base_id = event.baseId;
  if (event.tableId != null) payload.table_id = event.tableId;
  if (event.changes !== undefined) payload.changes = event.changes;
  if (event.recordVersion !== undefined) payload.record_version = event.recordVersion;
  if (event.data !== undefined) payload.data = event.data;
  if (event.batch !== undefined) payload.batch = { id: event.batch.id, size: event.batch.size };
  if (event.via !== undefined && Object.keys(event.via).length > 0) {
    payload.via = { ...event.via } as JsonObject;
  }
  return {
    id,
    organization_id: event.organizationId,
    type: event.type,
    entity_type: event.entityType ?? entityTypeOf(event.type),
    entity_id: event.entityId,
    actor_type: event.actor.type,
    actor_id: event.actor.id,
    payload,
    causation: (event.causation as Causation | undefined) ?? {
      root_event_id: id,
      depth: 0,
      automation_chain: [],
    },
  };
}

/** A stored `meta.events` row, as read back. */
export interface StoredEvent {
  readonly id: Id<'evt'>;
  readonly organization_id: Id<'org'>;
  readonly type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor_type: ActorType;
  readonly actor_id: string | null;
  readonly payload: JsonValue;
  readonly causation: JsonValue | null;
  readonly created_at: Date;
}

/** Rebuilds the CONTRACTS §8 document from a stored row. */
export function toEventDocument(row: StoredEvent): EventDocument {
  const payload = (
    typeof row.payload === 'object' && row.payload !== null && !Array.isArray(row.payload)
      ? row.payload
      : {}
  ) as Record<string, JsonValue>;
  const causation = causationSchema.safeParse(row.causation);
  return {
    id: row.id,
    type: row.type as EventType,
    organization_id: row.organization_id,
    ...(typeof payload.base_id === 'string' ? { base_id: payload.base_id as Id<'bse'> } : {}),
    ...(typeof payload.table_id === 'string' ? { table_id: payload.table_id as Id<'tbl'> } : {}),
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    actor: { type: row.actor_type, id: row.actor_id },
    ...(payload.changes === undefined
      ? {}
      : { changes: payload.changes as EventDocument['changes'] & object }),
    ...(typeof payload.record_version === 'number'
      ? { record_version: payload.record_version }
      : {}),
    ...(payload.data === undefined ? {} : { data: payload.data as JsonObject }),
    ...batchOf(payload.batch),
    ...viaOf(payload.via),
    causation: causation.success
      ? causation.data
      : { root_event_id: row.id, depth: 0, automation_chain: [] },
    created_at: row.created_at.toISOString(),
  };
}

function batchOf(value: JsonValue | undefined): { batch?: EventBatch } {
  const parsed = eventBatchSchema.safeParse(value);
  return parsed.success ? { batch: parsed.data } : {};
}

function viaOf(value: JsonValue | undefined): { via?: EventVia } {
  const parsed = eventViaSchema.safeParse(value);
  if (!parsed.success) return {};
  const via = Object.fromEntries(
    Object.entries(parsed.data).filter(([, id]) => id !== undefined),
  ) as EventVia;
  return Object.keys(via).length > 0 ? { via } : {};
}
