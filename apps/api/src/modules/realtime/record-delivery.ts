import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  REALTIME_RECORD_BATCH_THRESHOLD,
  tableChannel,
  type Id,
  type RealtimeRecordBatch,
  type RealtimeServerMessage,
  type RecordBatchOp,
  type StoredColorRule,
} from '@cellhive/contracts';
import {
  createEvaluator,
  resolveVariables,
  validateFilter,
  type EvaluateRecord,
  type FilterFieldMeta,
  type FilterNode,
  type FilterTableMeta,
} from '@cellhive/filter-dsl';
import { aiSourcesOf } from '@cellhive/server-core';

import {
  colorOfImage,
  compileColorRules,
  subscriberColorRules,
  type CompiledColorRule,
} from './color-rules.js';
import { pruneFilterLeaves, subscriberViewFilter } from './view-filter.js';

import type { Delivery, DeliveryStrategy } from './delivery.js';
import type { RuleVariables, Subscriber } from './realtime-connection.js';
import type { BaseAccess } from '../../common/access/access.service.js';
import type { RecordChangeItem, RecordChangesEnvelope } from '@cellhive/server-core';

/**
 * Longest stretch of synchronous work before yielding to the event loop
 * (`setImmediate`), so that a large envelope never blocks other sockets and
 * HTTP requests for long.
 */
export const RECORD_DELIVERY_SLICE_MS = 10;

/**
 * Longest wait for the remaining parts of a write split over several
 * envelopes; older partial state is dropped (a lost part: best effort).
 */
export const RECORD_BATCH_TTL_MS = 30_000;
/** Most writes split over several envelopes waiting for their last part. */
const MAX_PENDING_WRITES = 64;

type Readable = (image: EvaluateRecord) => boolean;

/**
 * What one subscriber may see of one table, derived from its access
 * (cached per `BaseAccess` object, i.e. per access check).
 */
interface TablePlan {
  /** Fields whose perm is not `no_perm`. */
  readonly visible: ReadonlySet<string>;
  /** Read rule: `null` = every record, `'none'` = no record. */
  readonly rule: FilterNode | null | 'none';
  readonly ruleKey: string;
  /** The rule uses `$var`/`$date` operands: evaluated per user. */
  readonly perUser: boolean;
  /** Same key ⇔ same fields and same rule. */
  readonly key: string;
}

/** Subscribers with the same access fingerprint: one evaluation, one message each. */
interface Group {
  readonly key: string;
  readonly plan: TablePlan;
  /** View filter applied on top of the read rule (T313), stored form; `null` = none. */
  readonly viewFilter: unknown;
  readonly viewKey: string;
  readonly userId: Id<'usr'>;
  readonly variables: RuleVariables | null;
  readonly subscribers: Subscriber[];
  /** Link fields whose titles this group may not see (T401): sent with `title: null`. */
  readonly hiddenTitles: ReadonlySet<string>;
  /**
   * Fields whose changes and values the group receives: the visible ones
   * without formula/lookup fields `locked` for it (T459).
   */
  readonly visible: ReadonlySet<string>;
  /**
   * Formula/lookup fields the group computes with its own read scope (a
   * record rule on a table they read, T457): their stored values are not
   * its values, so a write changing one gives the group a `record.batch`
   * (client refetch) and never the value (T459).
   */
  readonly scoped: ReadonlySet<string>;
  /** Fields whose values the group receives: `visible` without `scoped`. */
  readonly shown: ReadonlySet<string>;
  /**
   * The view filter names a field whose image value is not the group's
   * value (T462: virtual, `scoped`, or `locked` over a table the group reads
   * in part or not at all): the view cannot be decided here, so the group's
   * records follow the read rule alone and every write gives it one
   * `record.batch` (client refetch) instead of per-record messages.
   */
  readonly viewUncertain: boolean;
  /**
   * Color rules of the view that apply to the group (T816), stored form;
   * empty = messages carry no `meta`.
   */
  readonly colorRules: readonly StoredColorRule[];
  /**
   * A color rule names a field whose image value is not the group's value
   * (as `viewUncertain`): every write gives the group one `record.batch`, the
   * client refetches and reads colors from `records/query`.
   */
  readonly colorUncertain: boolean;
  readable: Readable;
  /** {@link colorRules} compiled (`null` without rules). */
  colors: readonly CompiledColorRule[] | null;
}

type Counts = Record<RecordBatchOp, number>;

/**
 * What one write means for one group so far: the per-record messages while
 * there are at most `threshold` of them, then only counts (T303).
 */
interface Tally {
  count: number;
  readonly ops: Counts;
  /** `null` once over the threshold: the group gets one `record.batch`. */
  messages: RealtimeServerMessage[] | null;
  /** A change of a value computed differently for the group (T459): one `record.batch`. */
  batchOnly: boolean;
}

/** A write split over several envelopes, waiting for its last part. */
interface PendingWrite {
  readonly at: number;
  readonly tallies: Map<string, Tally>;
}

function newTally(): Tally {
  return {
    count: 0,
    ops: { created: 0, updated: 0, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
    messages: [],
    batchOnly: false,
  };
}

/** The kind of per-record message, as counted in `record.batch`. */
function opOf(message: RealtimeServerMessage): RecordBatchOp | null {
  switch (message.type) {
    case 'record.created':
      return 'created';
    case 'record.updated':
      return 'updated';
    case 'record.added':
      return 'added';
    case 'record.removed_from_view':
      return 'removed_from_view';
    // Purged records (T408) leave the trash: counted with the deletions.
    case 'record.deleted':
    case 'record.purged':
      return 'deleted';
    case 'record.restored':
      return 'restored';
    default:
      return null;
  }
}

const NEVER: Readable = () => false;
const ALWAYS: Readable = () => true;

const plans = new WeakMap<BaseAccess, Map<string, TablePlan | null>>();

function planOf(base: BaseAccess, tableId: Id<'tbl'>): TablePlan | null {
  let byTable = plans.get(base);
  if (byTable === undefined) {
    byTable = new Map();
    plans.set(base, byTable);
  }
  const cached = byTable.get(tableId);
  if (cached !== undefined) return cached;
  let plan: TablePlan | null = null;
  const table = base.access.tables[tableId];
  if (table !== undefined) {
    const visible = Object.entries(table.fields)
      .filter(([, perm]) => (perm as string) !== 'no_perm')
      .map(([fieldId]) => fieldId)
      .sort();
    const filters = base.resolved.internal.readFilters;
    const rule: TablePlan['rule'] = Object.hasOwn(filters, tableId)
      ? (filters[tableId] ?? null)
      : 'none';
    const ruleKey = rule === null ? 'all' : rule === 'none' ? 'none' : JSON.stringify(rule);
    plan = {
      visible: new Set(visible),
      rule,
      ruleKey,
      perUser: ruleKey.includes('"$var"') || ruleKey.includes('"$date"'),
      key: `${ruleKey}\u0000${visible.join(',')}`,
    };
  }
  byTable.set(tableId, plan);
  return plan;
}

function usesVariables(json: string): boolean {
  return json.includes('"$var"') || json.includes('"$date"');
}

function groupKey(plan: TablePlan, subscriber: Subscriber, viewKey: string): string {
  const key = viewKey === '' ? plan.key : `${plan.key}\u0000view\u0000${viewKey}`;
  if (!plan.perUser && !usesVariables(viewKey)) return key;
  const variables = subscriber.variables;
  const members = variables === null ? '' : [...variables.groupMemberUserIds].sort().join(',');
  return `${key}\u0000${subscriber.userId}\u0000${variables?.timeZone ?? ''}\u0000${members}`;
}

/**
 * Keeps the entries of `values` whose field is visible; link cells of
 * `hiddenTitles` keep their record ids with `title: null` (P20, T401).
 */
function visibleValues(
  values: Readonly<Record<string, unknown>>,
  visible: ReadonlySet<string>,
  hiddenTitles: ReadonlySet<string> = NO_HIDDEN_TITLES,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(values)) {
    if (!visible.has(fieldId)) continue;
    fields[fieldId] = !hiddenTitles.has(fieldId)
      ? value
      : Array.isArray(value)
        ? value.map(withoutTitle)
        : // A parent cell (T405) is one `{ id, title }`.
          withoutTitle(value);
  }
  return fields;
}

const NO_HIDDEN_TITLES: ReadonlySet<string> = new Set();
const NO_FIELDS: ReadonlySet<string> = new Set();

function withoutFields(fields: ReadonlySet<string>, removed: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const field of fields) if (!removed.has(field)) out.add(field);
  return out;
}

function withoutTitle(ref: unknown): unknown {
  return typeof ref === 'object' && ref !== null && 'id' in ref ? { id: ref.id, title: null } : ref;
}

type EnvelopeLink = NonNullable<RecordChangesEnvelope['links']>[number];

/**
 * Whether a subscriber sees the titles of a link's records (T401,
 * CONTRACTS §7): it reads the linked table's primary field and every record
 * of that table (no read rule). Anything finer is left to a refetch, so a
 * title never reaches someone who cannot read it.
 */
function titlesVisible(base: BaseAccess, link: EnvelopeLink): boolean {
  if (link.title_field_id === null) return false;
  const table = base.access.tables[link.table_id];
  const perm: string | undefined = table?.fields[link.title_field_id];
  if (perm === undefined || perm === 'no_perm') return false;
  const filters = base.resolved.internal.readFilters;
  return Object.hasOwn(filters, link.table_id) && filters[link.table_id] === null;
}

type EnvelopeField = RecordChangesEnvelope['fields'][number];
type ComputedMeta = NonNullable<EnvelopeField['computed']>;

/**
 * How a formula/lookup field of an envelope reaches a subscriber (T459,
 * CONTRACTS §7), decided like `RecordQueryService` does (T457, S4b open
 * question #1) from the subscriber's access:
 *
 * - `locked`: it reads a table the subscriber cannot read, or a field of
 *   other records they cannot read (with `strict`, a field of the same
 *   record too) — never sent, like a hidden field;
 * - `scoped`: it reads a table where the subscriber has a record rule —
 *   the stored value is computed over every record, not theirs: a change
 *   gives them a `record.batch` (refetch), never the value;
 * - `plain`: the stored value is theirs.
 */
export function computedDelivery(
  base: BaseAccess,
  meta: ComputedMeta,
): 'locked' | 'scoped' | 'plain' {
  const tableReadable = (tableId: string): boolean => {
    const table = base.access.tables[tableId as Id<'tbl'>];
    return table !== undefined && (table.perm as string) !== 'no_perm';
  };
  const fieldReadable = (ref: { table_id: string; field_id: string }): boolean => {
    if (!tableReadable(ref.table_id)) return false;
    const fields = base.access.tables[ref.table_id as Id<'tbl'>]?.fields;
    const perm: string | undefined = fields?.[ref.field_id as Id<'fld'>];
    return perm !== undefined && perm !== 'no_perm';
  };
  if (!meta.tables.every(tableReadable)) return 'locked';
  if (!meta.cross_fields.every(fieldReadable)) return 'locked';
  if (meta.strict && !meta.same_row_fields.every(fieldReadable)) return 'locked';
  const filters = base.resolved.internal.readFilters;
  const scoped = meta.tables.some(
    (tableId) => !Object.hasOwn(filters, tableId) || (filters[tableId] ?? null) !== null,
  );
  return scoped ? 'scoped' : 'plain';
}

/**
 * Whether the image value of a formula/lookup field of an envelope is not
 * the subscriber's value (T462), so a view condition on it cannot be
 * evaluated on images: a virtual field (no image value), or one reading a
 * table the subscriber cannot read or reads under a record rule — queries
 * compute it with the subscriber's own read scope (T457, S4b #1b).
 */
export function computedImageDiverges(base: BaseAccess, meta: ComputedMeta): boolean {
  if (meta.virtual === true) return true;
  const filters = base.resolved.internal.readFilters;
  return meta.tables.some((tableId) => {
    const table = base.access.tables[tableId];
    if (table === undefined || (table.perm as string) === 'no_perm') return true;
    return !Object.hasOwn(filters, tableId) || (filters[tableId] ?? null) !== null;
  });
}

interface ComputedClasses {
  /**
   * Two letters per computed field of the envelope (`l`, `s`, `p`, then `!`
   * when its image diverges, `-` otherwise): part of the group key.
   */
  readonly key: string;
  readonly locked: ReadonlySet<string>;
  readonly scoped: ReadonlySet<string>;
  /** Fields whose image value is not the group's value ({@link computedImageDiverges}). */
  readonly diverging: ReadonlySet<string>;
}

/** Per-access classes of the envelope's computed fields (`null`: the envelope has none). */
function computedClasses(
  envelope: RecordChangesEnvelope,
): (base: BaseAccess) => ComputedClasses | null {
  const computed = envelope.fields.flatMap((field) => {
    if (field.computed !== undefined) return [{ id: field.id, meta: field.computed }];
    // AI fields (T910) are always strict: locked for a subscriber missing a field
    // of their prompt (fields of the same record only), whatever the base setting.
    const sources = aiSourcesOf(field);
    if (sources.length === 0) return [];
    const meta: ComputedMeta = {
      tables: [],
      cross_fields: [],
      same_row_fields: sources.map((id) => ({ table_id: envelope.table_id, field_id: id })),
      strict: true,
    };
    return [{ id: field.id, meta }];
  });
  if (computed.length === 0) return () => null;
  const cache = new WeakMap<BaseAccess, ComputedClasses>();
  return (base) => {
    let found = cache.get(base);
    if (found === undefined) {
      const locked = new Set<string>();
      const scoped = new Set<string>();
      const diverging = new Set<string>();
      let key = '';
      for (const field of computed) {
        const kind = computedDelivery(base, field.meta);
        if (kind === 'locked') locked.add(field.id);
        else if (kind === 'scoped') scoped.add(field.id);
        const diverges = computedImageDiverges(base, field.meta);
        if (diverges) diverging.add(field.id);
        key += kind.charAt(0) + (diverges ? '!' : '-');
      }
      found = { key, locked, scoped, diverging };
      cache.set(base, found);
    }
    return found;
  };
}

/** Whether a stored-form filter has a leaf on one of `fields`. */
function namesAnyField(node: unknown, fields: ReadonlySet<string>): boolean {
  if (Array.isArray(node)) return node.some((item) => namesAnyField(item, fields));
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  const field = record['field'];
  if (typeof field === 'string' && fields.has(field)) return true;
  return namesAnyField(record['items'], fields) || namesAnyField(record['item'], fields);
}

export interface RecordDeliveryOptions {
  /** Clock of date operands in read rules (`today`…) and of held writes; tests pin it. */
  readonly now?: () => Date;
  /** See {@link RECORD_DELIVERY_SLICE_MS}. */
  readonly sliceMs?: number;
  /** See `REALTIME_RECORD_BATCH_THRESHOLD` (CONTRACTS §7). */
  readonly batchThreshold?: number;
  /** See {@link RECORD_BATCH_TTL_MS}. */
  readonly batchTtlMs?: number;
}

/**
 * `record.changes` (T210, CONTRACTS §7, SPEC §15) on `table:<id>`.
 *
 * Subscribers are grouped by access fingerprint (visible fields + read
 * rule, plus user, zone and group members when the rule has variables);
 * for each group the read rule is validated against the field meta of the
 * envelope and evaluated (`@cellhive/filter-dsl`) on the images before and
 * after each change — no database read. Per change and group:
 *
 * | change | readable before → after | message |
 * |---|---|---|
 * | created | – → yes | `record.created`, visible fields only |
 * | updated | yes → yes | `record.updated` with the visible changed fields (none visible → nothing, P23) |
 * | updated | no → yes | `record.added` (the client fetches the record) |
 * | updated | yes → no | `record.removed_from_view` |
 * | deleted | yes → – | `record.deleted` (consecutive ones batched) |
 * | restored | – → yes | `record.restored` (consecutive ones batched) |
 * | purged (T408) | yes → – | `record.purged` (consecutive ones batched; `deleted` in `record.batch`) |
 *
 * `no_perm` fields never appear; a rule that does not validate against the
 * envelope (e.g. it names a field that is gone) reads nothing (fails
 * closed). Work is sliced with `setImmediate` so one large envelope never
 * holds the event loop for more than about {@link RECORD_DELIVERY_SLICE_MS}.
 *
 * View (T313, ADR-0031): a subscription made with the view open on screen
 * reads "readable" as read rule AND the view's saved filter (only its part
 * hidden from the subscriber with `filter_mode: replace`), resolved for the
 * subscriber, so `created`/`added`/`removed_from_view` follow the view —
 * conditions the subscriber cannot see included — and records outside it
 * send nothing. Saved conditions that no longer validate are ignored (as in
 * `records/query`).
 *
 * Link cells changed by another table (T402, envelope `link_fanout`):
 * renamed / trashed / restored linked records give `record.updated`
 * (`event_id: null`) of the linking records through the same table above;
 * a rename sends nothing to groups that may not see the link's titles, and
 * an envelope without values (more than the threshold of linking records)
 * always gives each group one `record.batch`.
 *
 * Computed values (T459): envelope fields with `computed` meta (formula /
 * lookup) are classed per group ({@link computedDelivery}, part of the
 * group key): `locked` ones are treated as hidden fields (no change, no
 * value — with `filter_mode: replace` their view conditions apply here,
 * T462); `scoped` ones (a record rule on a table they read) never send
 * their stored value — a write that changes one gives the group one
 * `record.batch` whatever the count. A view filter naming a field whose
 * image is not the group's value (virtual, scoped, or locked over a table
 * read in part; {@link computedImageDiverges}, T462) cannot be decided on
 * images: the group follows its read rule alone and every write gives it
 * one `record.batch` (client refetch) — never a silently ignored
 * condition. Recomputed values arrive as `record.updated` with `event_id:
 * null` like other system recomputes.
 *
 * Batching (T303): when one write would send a group more than
 * `REALTIME_RECORD_BATCH_THRESHOLD` per-record messages, the group gets one
 * `record.batch` (counts of the records it can read) instead. A write split
 * over several envelopes (`batch` marker) is decided as a whole: its
 * messages are held until the last part.
 */
export class RecordDeliveryStrategy implements DeliveryStrategy<RecordChangesEnvelope> {
  readonly type = 'record.changes' as const;
  readonly #now: () => Date;
  readonly #sliceMs: number;
  readonly #threshold: number;
  readonly #ttlMs: number;
  readonly #pending = new Map<string, PendingWrite>();

  constructor(options: RecordDeliveryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#sliceMs = options.sliceMs ?? RECORD_DELIVERY_SLICE_MS;
    this.#threshold = options.batchThreshold ?? REALTIME_RECORD_BATCH_THRESHOLD;
    this.#ttlMs = options.batchTtlMs ?? RECORD_BATCH_TTL_MS;
  }

  /** Writes split over several envelopes still waiting for their last part (tests). */
  get pendingWrites(): number {
    return this.#pending.size;
  }

  channels(envelope: RecordChangesEnvelope): readonly string[] {
    return [tableChannel(envelope.table_id)];
  }

  async deliver(
    envelope: RecordChangesEnvelope,
    subscribers: readonly Subscriber[],
  ): Promise<readonly Delivery[]> {
    const write = this.pendingWrite(envelope);
    const groups = this.groups(envelope, subscribers);
    const channel = tableChannel(envelope.table_id);
    const tallies = write?.tallies ?? new Map<string, Tally>();

    if (groups.length > 0) {
      const own = groups.map((group) => {
        let tally = tallies.get(group.key);
        if (tally === undefined) {
          tally = newTally();
          tallies.set(group.key, tally);
        }
        return tally;
      });
      let sliceStart = performance.now();
      for (const change of envelope.changes) {
        for (let index = 0; index < groups.length; index += 1) {
          const group = groups[index] as Group;
          const tally = own[index] as Tally;
          const message = this.messageFor(
            envelope,
            change,
            group,
            channel,
            tally.messages !== null && envelope.link_fanout?.values !== false,
          );
          if (message === null) continue;
          this.count(tally, message, change.record_id);
          // The view (T462) or colors (T816) cannot be decided on images: the client refetches.
          if (group.viewUncertain || group.colorUncertain) tally.batchOnly = true;
          if (
            message.type === 'record.updated' &&
            group.scoped.size > 0 &&
            change.changed.some((fieldId) => group.scoped.has(fieldId))
          ) {
            tally.batchOnly = true;
          }
        }
        if (performance.now() - sliceStart >= this.#sliceMs) {
          await yieldToEventLoop();
          sliceStart = performance.now();
        }
      }
    }

    const batch = envelope.batch;
    if (batch !== undefined) {
      if (batch.part < batch.parts - 1) return [];
      this.#pending.delete(this.pendingKey(envelope));
    }

    // Last (or only) part: to the groups subscribed now.
    const deliveries: Delivery[] = [];
    for (const group of groups) {
      const tally = tallies.get(group.key);
      if (tally === undefined || tally.count === 0) continue;
      // Link cells changed by another table without values (T402): always one batch.
      const batchOnly = envelope.link_fanout?.values === false;
      const messages: readonly RealtimeServerMessage[] =
        tally.messages === null || batchOnly || tally.batchOnly
          ? [this.batchMessage(envelope, channel, tally)]
          : tally.messages;
      for (const message of messages) {
        for (const subscriber of group.subscribers) deliveries.push({ subscriber, message });
      }
    }
    return deliveries;
  }

  /** Adds one per-record message to a tally; above the threshold only counts remain. */
  private count(tally: Tally, message: RealtimeServerMessage, recordId: Id<'rec'>): void {
    const op = opOf(message);
    if (op === null) return;
    tally.count += 1;
    tally.ops[op] += 1;
    if (tally.messages === null) return;
    if (tally.count > this.#threshold) {
      tally.messages = null;
      return;
    }
    // Consecutive deletes/restores are sent as one message.
    const last = tally.messages.at(-1);
    if (
      (message.type === 'record.deleted' ||
        message.type === 'record.restored' ||
        message.type === 'record.purged') &&
      last?.type === message.type
    ) {
      last.record_ids.push(recordId);
      return;
    }
    tally.messages.push(message);
  }

  private batchMessage(
    envelope: RecordChangesEnvelope,
    channel: `table:${string}`,
    tally: Tally,
  ): RealtimeRecordBatch {
    return {
      type: 'record.batch',
      channel,
      actor_id: envelope.actor_id,
      count: tally.count,
      ops: { ...tally.ops },
    };
  }

  private pendingKey(envelope: RecordChangesEnvelope): string {
    return `${envelope.organization_id}\u0000${envelope.table_id}\u0000${envelope.batch?.id ?? ''}`;
  }

  /**
   * The state of a write split over several envelopes (created at the first
   * part seen); `undefined` for a write in one envelope. Writes whose last
   * part never came are dropped after a while.
   */
  private pendingWrite(envelope: RecordChangesEnvelope): PendingWrite | undefined {
    const now = this.#now().getTime();
    for (const [key, write] of this.#pending) {
      // Oldest first (insertion order).
      if (now - write.at <= this.#ttlMs && this.#pending.size < MAX_PENDING_WRITES) break;
      this.#pending.delete(key);
    }
    if (envelope.batch === undefined) return undefined;
    const key = this.pendingKey(envelope);
    let write = this.#pending.get(key);
    if (write === undefined) {
      write = { at: now, tallies: new Map() };
      this.#pending.set(key, write);
    }
    return write;
  }

  /**
   * The message for one group about one change; deletes/restores come back
   * with one id. Without `build` (the group is over the threshold) only its
   * type matters, so no field is copied.
   */
  private messageFor(
    envelope: RecordChangesEnvelope,
    change: RecordChangeItem,
    group: Group,
    channel: `table:${string}`,
    build = true,
  ): RealtimeServerMessage | null {
    const before = change.before !== null && group.readable(change.before);
    const after = change.after !== null && group.readable(change.after);
    const visible = group.visible;
    const shown = group.shown;
    switch (change.op) {
      case 'created':
        if (!after || change.event_id === null) return null;
        return {
          type: 'record.created',
          channel,
          record_id: change.record_id,
          version: change.version,
          fields: build ? visibleValues(change.values, shown, group.hiddenTitles) : {},
          ...(build && group.colors !== null && change.after !== null
            ? { meta: { color: colorOfImage(group.colors, change.after) } }
            : {}),
          actor_id: envelope.actor_id,
          event_id: change.event_id,
        };
      case 'updated':
        if (before && after) {
          if (!change.changed.some((fieldId) => visible.has(fieldId))) return null;
          // Renamed linked records (T402): nothing changes for who may not see titles.
          const fanout = envelope.link_fanout;
          if (fanout?.titles_only === true && group.hiddenTitles.has(fanout.field_id)) return null;
          return {
            type: 'record.updated',
            channel,
            record_id: change.record_id,
            version: change.version,
            fields: build ? visibleValues(change.values, shown, group.hiddenTitles) : {},
            ...(build && group.colors !== null && change.after !== null
              ? { meta: { color: colorOfImage(group.colors, change.after) } }
              : {}),
            actor_id: envelope.actor_id,
            event_id: change.event_id,
          };
        }
        if (after) return { type: 'record.added', channel, record_id: change.record_id };
        if (before) {
          return { type: 'record.removed_from_view', channel, record_id: change.record_id };
        }
        return null;
      case 'deleted':
        return before ? { type: 'record.deleted', channel, record_ids: [change.record_id] } : null;
      case 'restored':
        return after ? { type: 'record.restored', channel, record_ids: [change.record_id] } : null;
      case 'purged':
        return before ? { type: 'record.purged', channel, record_ids: [change.record_id] } : null;
    }
  }

  /** Subscribers grouped by fingerprint, each group with its compiled read rule. */
  private groups(envelope: RecordChangesEnvelope, subscribers: readonly Subscriber[]): Group[] {
    const tableId = envelope.table_id;
    const active = new Set<string>(envelope.fields.map((field) => field.id));
    const classesOf = computedClasses(envelope);
    const byKey = new Map<string, Group>();
    for (const subscriber of subscribers) {
      if (subscriber.base === null) continue;
      const plan = planOf(subscriber.base, tableId);
      if (plan === null) continue;
      const classes = classesOf(subscriber.base);
      // A locked field reads `null` for the subscriber: with `filter_mode: replace`,
      // its conditions are part of what they cannot see and apply here (T462).
      const seen =
        classes === null || classes.locked.size === 0
          ? plan.visible
          : withoutFields(plan.visible, classes.locked);
      const namedFilter =
        subscriber.view === null ? null : subscriberViewFilter(subscriber.view, seen, active);
      const viewUncertain =
        namedFilter !== null &&
        classes !== null &&
        classes.diverging.size > 0 &&
        namesAnyField(namedFilter, classes.diverging);
      const viewFilter = viewUncertain ? null : namedFilter;
      const filterKey = viewUncertain
        ? '\u0000uncertain'
        : viewFilter === null
          ? ''
          : JSON.stringify(viewFilter);
      // Color rules of the view that apply to the subscriber (T816).
      const colorRules = subscriberColorRules(subscriber.view?.colorRules, seen, plan.visible);
      const colorUncertain =
        colorRules.length > 0 &&
        classes !== null &&
        classes.diverging.size > 0 &&
        namesAnyField(
          colorRules.map((rule) => rule.filter),
          classes.diverging,
        );
      const viewKey =
        colorRules.length === 0
          ? filterKey
          : `${filterKey}\u0000colors\u0000${colorUncertain ? 'uncertain' : JSON.stringify(colorRules)}`;
      const base = subscriber.base;
      const hidden = (envelope.links ?? [])
        .filter((link) => !titlesVisible(base, link))
        .map((link) => link.field_id);
      const titlesKey = hidden.length === 0 ? '' : `\u0000titles\u0000${hidden.join(',')}`;
      const computedKey = classes === null ? '' : `\u0000computed\u0000${classes.key}`;
      const key = groupKey(plan, subscriber, viewKey) + titlesKey + computedKey;
      let group = byKey.get(key);
      if (group === undefined) {
        const visible =
          classes === null || classes.locked.size === 0
            ? plan.visible
            : withoutFields(plan.visible, classes.locked);
        const scoped = classes === null || classes.scoped.size === 0 ? NO_FIELDS : classes.scoped;
        group = {
          key,
          plan,
          viewFilter,
          viewKey,
          userId: subscriber.userId,
          variables: subscriber.variables,
          subscribers: [],
          hiddenTitles: hidden.length === 0 ? NO_HIDDEN_TITLES : new Set(hidden),
          visible,
          scoped,
          shown: scoped.size === 0 ? visible : withoutFields(visible, scoped),
          viewUncertain,
          colorRules: colorUncertain ? [] : colorRules,
          colorUncertain,
          readable: NEVER,
          colors: null,
        };
        byKey.set(key, group);
      }
      group.subscribers.push(subscriber);
    }
    if (byKey.size === 0) return [];

    const table: FilterTableMeta = {
      fields: envelope.fields.map((field): FilterFieldMeta => {
        const computed = field.computed;
        return {
          id: field.id,
          name: field.id,
          type: field.type as FilterFieldMeta['type'],
          options: field.options,
          // Formula/lookup: operators and values of the result type (T457, T459).
          ...(computed?.result_type === undefined
            ? {}
            : { resultType: computed.result_type as FilterFieldMeta['type'] }),
          ...(computed?.result_options === undefined
            ? {}
            : { resultOptions: computed.result_options }),
          ...(computed?.result_is_list === undefined
            ? {}
            : { resultIsList: computed.result_is_list }),
        };
      }),
    };
    const fieldIds = envelope.fields.map((field) => field.id);
    const validated = new Map<string, FilterNode | null>();
    const validatedViews = new Map<string, FilterNode | 'all'>();
    const now = this.#now();
    for (const group of byKey.values()) {
      const rule = this.compile(group, table, fieldIds, validated, now);
      const view = this.compileView(group, table, fieldIds, validatedViews, now);
      group.readable =
        rule === NEVER || view === NEVER
          ? NEVER
          : view === ALWAYS
            ? rule
            : rule === ALWAYS
              ? view
              : (image) => rule(image) && view(image);
      group.colors =
        group.colorRules.length === 0
          ? null
          : compileColorRules(group.colorRules, table, fieldIds, {
              userId: group.userId,
              groupMemberUserIds: group.variables?.groupMemberUserIds ?? [],
              timeZone: group.variables?.timeZone ?? 'UTC',
              now,
            });
    }
    return [...byKey.values()];
  }

  /**
   * The view filter of a group (T313): conditions that do not validate
   * against the envelope's fields are dropped (ignored, as in queries by
   * members); what is left is resolved for the group's user and evaluated.
   */
  private compileView(
    group: Group,
    table: FilterTableMeta,
    fieldIds: readonly string[],
    validated: Map<string, FilterNode | 'all'>,
    now: Date,
  ): Readable {
    // Views naming values computed differently for the group (T459, T462) never
    // reach here (`viewUncertain`: the group gets a `record.batch`).
    if (group.viewFilter === null) return ALWAYS;
    let ast = validated.get(group.viewKey);
    if (ast === undefined) {
      const validates = (node: unknown) => validateFilter(node, table, fieldIds).ok;
      const pruned = pruneFilterLeaves(group.viewFilter, (leaf) =>
        validates({ op: 'and', items: [leaf] }),
      );
      const result = pruned === null ? null : validateFilter(pruned, table, fieldIds);
      ast = result === null ? 'all' : result.ok ? result.ast : 'all';
      validated.set(group.viewKey, ast);
    }
    if (ast === 'all') return ALWAYS;
    const timeZone = group.variables?.timeZone ?? 'UTC';
    try {
      const evaluate = createEvaluator(
        resolveVariables(ast, {
          userId: group.userId,
          groupMemberUserIds: group.variables?.groupMemberUserIds ?? [],
          timeZone,
          now,
        }),
        { table, timeZone },
      );
      return (image) => {
        try {
          return evaluate(image);
        } catch {
          return false;
        }
      };
    } catch {
      return NEVER;
    }
  }

  private compile(
    group: Group,
    table: FilterTableMeta,
    fieldIds: readonly string[],
    validated: Map<string, FilterNode | null>,
    now: Date,
  ): Readable {
    const { rule, ruleKey } = group.plan;
    if (rule === null) return ALWAYS;
    if (rule === 'none') return NEVER;
    let ast = validated.get(ruleKey);
    if (ast === undefined) {
      const result = validateFilter(rule, table, fieldIds);
      ast = result.ok ? result.ast : null;
      validated.set(ruleKey, ast);
    }
    if (ast === null) return NEVER;
    const timeZone = group.variables?.timeZone ?? 'UTC';
    try {
      const resolved = resolveVariables(ast, {
        userId: group.userId,
        groupMemberUserIds: group.variables?.groupMemberUserIds ?? [],
        timeZone,
        now,
      });
      const evaluate = createEvaluator(resolved, { table, timeZone });
      return (image) => {
        try {
          return evaluate(image);
        } catch {
          return false;
        }
      };
    } catch {
      return NEVER;
    }
  }
}
