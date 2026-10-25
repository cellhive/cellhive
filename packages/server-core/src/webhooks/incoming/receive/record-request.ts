import { newId, type Id } from '@cellhive/contracts';

import { orgScope } from '../../../db/repository.js';
import { EventWriter } from '../../../events/event-writer.js';
import { publishRealtime } from '../../../realtime/bus.js';
import { REALTIME_ENVELOPE_VERSION } from '../../../realtime/envelope.js';
import { sampleToJson, type IncomingWebhookSampleData } from '../sample/sample.js';

import type { Db, Tx } from '../../../db/create-db.js';
import type { JsonValue } from '../../../db/schema.js';
import type { Causation } from '../../../events/event.js';
import type {
  IncomingWebhookRequestsRepository,
  IncomingWebhooksRepository,
} from '../incoming-webhooks.repository.js';

export interface ReceivedRequest {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly incomingWebhookId: Id<'hok'>;
  /** Replay key (signed `webhook-id`), `null` without a signing secret. */
  readonly messageId: string | null;
  readonly body: JsonValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly sizeBytes: number;
  /** From `X-Cellhive-Causation`; `undefined` = a new chain. */
  readonly causation: Causation | undefined;
  readonly causationAccepted: boolean;
  /** Built and stored only when the hook is listening for a sample. */
  readonly sample: () => IncomingWebhookSampleData;
}

export type RecordedRequest =
  | {
      readonly kind: 'accepted';
      readonly requestId: Id<'whr'>;
      readonly eventId: Id<'evt'>;
      /** The member who was listening when this request became the sample. */
      readonly sampleCapturedFor: Id<'usr'> | null;
    }
  | { readonly kind: 'duplicate'; readonly requestId: Id<'whr'> };

const events = new EventWriter();

/**
 * Stores an authenticated request to a hook (ADR-35 §1 step 7, BACKLOG
 * T603), in `tx`:
 *
 * 1. the request row (`meta.incoming_webhook_requests`, kept 7 days) — a
 *    `webhook-id` already stored for the hook inserts nothing: the replay
 *    is logged as a `duplicate` row (no message id, body or event) and no
 *    event is written (CONTRACTS §10);
 * 2. the event `webhook.received` (payload ids only:
 *    `data = { incoming_webhook_id, request_id }`, `actor = { type:
 *    webhook, id: hok_… }`, the causation of the header) and its
 *    `events.dispatch` job;
 * 3. the sample, when the hook's listening window is open (first request
 *    wins, the window closes), and `incoming_webhook.sample_captured` to the
 *    listener after commit.
 *
 * `webhook.received` is not audited: the request row is its record
 * (CONTRACTS §8).
 */
export async function recordIncomingWebhookRequest(
  db: Db,
  tx: Tx,
  repositories: {
    readonly hooks: IncomingWebhooksRepository;
    readonly requests: IncomingWebhookRequestsRepository;
  },
  input: ReceivedRequest,
): Promise<RecordedRequest> {
  const scope = orgScope(input.organizationId, tx);
  const requestId = newId('whr');
  const eventId = newId('evt');
  const row = await repositories.requests.insert(scope, {
    id: requestId,
    incomingWebhookId: input.incomingWebhookId,
    messageId: input.messageId,
    body: input.body,
    headers: input.headers,
    query: input.query,
    sizeBytes: input.sizeBytes,
    causationAccepted: input.causationAccepted,
    eventId,
  });
  if (row === undefined) {
    const duplicate = await repositories.requests.insertDuplicate(scope, {
      id: newId('whr'),
      incomingWebhookId: input.incomingWebhookId,
      sizeBytes: input.sizeBytes,
    });
    return { kind: 'duplicate', requestId: duplicate.id };
  }

  await events.writeMany(
    tx,
    [
      {
        type: 'webhook.received',
        organizationId: input.organizationId,
        entityType: 'incoming_webhook',
        entityId: input.incomingWebhookId,
        baseId: input.baseId,
        actor: { type: 'webhook', id: input.incomingWebhookId },
        data: { incoming_webhook_id: input.incomingWebhookId, request_id: requestId },
        ...(input.causation === undefined ? {} : { causation: input.causation }),
      },
    ],
    [eventId],
  );

  const captured = await repositories.hooks.captureSample(scope, input.incomingWebhookId, () =>
    sampleToJson(input.sample()),
  );
  if (captured?.listenedBy != null) {
    await publishRealtime(db, tx, {
      v: REALTIME_ENVELOPE_VERSION,
      type: 'incoming_webhook.sample_captured',
      organization_id: input.organizationId,
      user_id: captured.listenedBy,
      incoming_webhook_id: input.incomingWebhookId,
    });
  }
  return {
    kind: 'accepted',
    requestId,
    eventId,
    sampleCapturedFor: captured?.listenedBy ?? null,
  };
}
