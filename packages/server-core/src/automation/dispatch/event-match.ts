import {
  WEBHOOK_TRIGGER_UNIT_PREFIX,
  type AutomationTrigger,
  type AutomationTriggerType,
  type EventType,
  type Id,
} from '@cellhive/contracts';

import { conditionFieldIdsOf, MATCHES_EVENT_TYPES } from './matches/transition.js';

import type { EventDocument } from '../../events/event.js';

/**
 * Which automation triggers an event can start (SPEC §11.1–11.2, BACKLOG
 * T503) besides `record.matches` (T510: `record.created|updated|restored`).
 * Other trigger types (`schedule`, `record.date_reached`,
 * `button.clicked`) are started by their own tasks (T508, T517), never by
 * `events.dispatch` of a single event type.
 */
export const DISPATCHED_TRIGGERS: Readonly<Partial<Record<EventType, AutomationTriggerType>>> = {
  'record.created': 'record.created',
  'record.updated': 'record.updated',
  'record.deleted': 'record.deleted',
  'form.submitted': 'form.submitted',
  // T604: one event per accepted request of an incoming webhook (no table).
  'webhook.received': 'webhook.received',
};

/** The trigger type `event` starts, or `undefined` (no automation listens to it). */
export function triggerTypeFor(
  event: Pick<EventDocument, 'type'>,
): AutomationTriggerType | undefined {
  return DISPATCHED_TRIGGERS[event.type];
}

/** Every trigger type `event` can start (`record.matches` included, T510). */
export function triggerTypesFor(event: Pick<EventDocument, 'type'>): AutomationTriggerType[] {
  const out: AutomationTriggerType[] = [];
  const own = DISPATCHED_TRIGGERS[event.type];
  if (own !== undefined) out.push(own);
  if (MATCHES_EVENT_TYPES.has(event.type)) out.push('record.matches');
  return out;
}

/**
 * A bulk change (ADR-26 §2): part of an import (`via.import_job_id`), values
 * recomputed by a `computed.recompute` run (`via.computed_recompute` with a
 * `job_id`, T509), or a call that changed two or more records — except a
 * form submission (`via.share_link_id`), which creates one record at a time.
 */
export function isBulkEvent(event: Pick<EventDocument, 'batch' | 'via'>): boolean {
  if (event.via?.import_job_id !== undefined) return true;
  if (event.via?.computed_recompute === true && event.via.job_id != null) return true;
  return (
    event.batch !== undefined && event.batch.size >= 2 && event.via?.share_link_id === undefined
  );
}

/**
 * The trigger unit of a run (ADR-26 §5): the batch of a bulk event (one
 * paste, one import), else the root event of the causation chain — except
 * a `webhook.received` event that starts its own chain (no valid
 * `X-Cellhive-Causation`, so its root is itself): every request of one
 * hook within the same second is one unit, `webhook:<hok>:<epoch second>`
 * (ADR-35 §5, amending ADR-26 §5 — a hook makes at most 60 units a minute,
 * so its default 5 req/s never trips the breaker).
 */
export function triggerUnitOf(
  event: Pick<EventDocument, 'batch' | 'via' | 'causation'> &
    Partial<Pick<EventDocument, 'id' | 'type' | 'data' | 'created_at'>>,
): string {
  if (isBulkEvent(event) && event.batch !== undefined) return event.batch.id;
  if (event.type === 'webhook.received' && event.causation.root_event_id === event.id) {
    const hookId = event.data?.['incoming_webhook_id'];
    const at = Date.parse(event.created_at ?? '');
    if (typeof hookId === 'string' && Number.isFinite(at)) {
      return webhookTriggerUnit(hookId, new Date(at));
    }
  }
  return event.causation.root_event_id;
}

/** The trigger unit of the requests of `hookId` received within the second of `at`. */
export function webhookTriggerUnit(hookId: string, at: Date): string {
  return `${WEBHOOK_TRIGGER_UNIT_PREFIX}${hookId}:${String(Math.floor(at.getTime() / 1000))}`;
}

/** The incoming webhook a `webhook.received` event is about, else `null`. */
export function webhookIdOf(event: Pick<EventDocument, 'type' | 'data'>): Id<'hok'> | null {
  if (event.type !== 'webhook.received') return null;
  const id = event.data?.['incoming_webhook_id'];
  return typeof id === 'string' && id.startsWith('hok_') ? (id as Id<'hok'>) : null;
}

/** The record an event is about (record events: the entity; `form.submitted`: the new record). */
export function triggerRecordIdOf(event: EventDocument): Id<'rec'> | null {
  if (event.type === 'form.submitted') {
    const id = event.data?.record_id;
    return typeof id === 'string' && id.startsWith('rec_') ? (id as Id<'rec'>) : null;
  }
  return event.entity_type === 'record' && event.entity_id.startsWith('rec_')
    ? (event.entity_id as Id<'rec'>)
    : null;
}

/** Why a trigger does not fire for an event, or `null` when it does. */
export type TriggerMismatch =
  | 'other_trigger'
  | 'other_table'
  | 'other_view'
  | 'watch_fields_unchanged'
  | 'condition_fields_unchanged'
  | 'other_webhook'
  | 'bulk_skipped';

/**
 * Whether `trigger` fires for `event` (SPEC §11.2, ADR-26 §3): same type
 * and table; `record.updated` only when a watched field is in `changes`;
 * `record.matches` on `record.updated` only when a field of its condition
 * is in `changes` (otherwise both sides of the change are the same, T510);
 * `form.submitted` only for its form view; `webhook.received` only for its
 * hook (T604); record triggers with
 * `skip_bulk` ignore bulk events.
 */
export function triggerMismatch(
  trigger: AutomationTrigger,
  event: EventDocument,
): TriggerMismatch | null {
  if (!triggerTypesFor(event).includes(trigger.type)) return 'other_trigger';
  switch (trigger.type) {
    case 'record.created':
    case 'record.updated':
    case 'record.deleted': {
      if (event.table_id !== trigger.table_id) return 'other_table';
      if (trigger.type === 'record.updated') {
        const changed = event.changes ?? {};
        if (!trigger.watch_fields.some((fieldId) => Object.hasOwn(changed, fieldId))) {
          return 'watch_fields_unchanged';
        }
      }
      if (trigger.skip_bulk && isBulkEvent(event)) return 'bulk_skipped';
      return null;
    }
    case 'record.matches': {
      if (event.table_id !== trigger.table_id) return 'other_table';
      if (event.type === 'record.updated') {
        const changed = event.changes ?? {};
        const fields = conditionFieldIdsOf(trigger.condition);
        if (![...fields].some((fieldId) => Object.hasOwn(changed, fieldId))) {
          return 'condition_fields_unchanged';
        }
      }
      if (trigger.skip_bulk && isBulkEvent(event)) return 'bulk_skipped';
      return null;
    }
    case 'form.submitted':
      return event.data?.view_id === trigger.view_id ? null : 'other_view';
    case 'webhook.received':
      return webhookIdOf(event) === trigger.incoming_webhook_id ? null : 'other_webhook';
    default:
      return 'other_trigger';
  }
}
