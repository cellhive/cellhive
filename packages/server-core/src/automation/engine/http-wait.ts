import { isId, type Id } from '@cellhive/contracts';

import { withTxScope, type OrgScope } from '../../db/repository.js';
import { HttpDeliveriesRepository } from '../../http-out/http-deliveries.repository.js';
import { AutomationRunStepsRepository } from '../repository/automation-run-steps.repository.js';
import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';

import type { Db, Tx } from '../../db/create-db.js';
import type {
  AutomationRunStepRow,
  HttpDeliveryRow,
  JsonObject,
  JsonValue,
} from '../../db/schema.js';
import type { Causation } from '../../events/event.js';
import type { HttpOutbox } from '../../http-out/http-outbox.js';
import type { HttpDeliveryRequest } from '../../http-out/request-crypto.js';

/**
 * A step waiting for an outbound HTTP delivery (ADR-35 §4, BACKLOG T605).
 * The run engine only calls these functions; the outbox (`http-out/**`)
 * owns the delivery rows.
 *
 * - **Park** (phase 1, one transaction): the handler of an HTTP action
 *   (`http_request`, `run_n8n_workflow` — T606/T607) returns
 *   `{ delivery }` instead of doing the call; the engine inserts the
 *   delivery row with the step's idempotency key and the run's causation,
 *   the step goes `waiting` with output `{ delivery_id }` and the run
 *   `waiting` like a `delay` (its running segment ends, it holds no slot,
 *   waiting is not running time). No `automation.run` job is added: the
 *   delivery wakes the run.
 * - **Settle** (phase 2, the outbox's TX-b): the final outcome finishes the
 *   `waiting` step — `succeeded` with the response output, or `failed` with
 *   the delivery's code — and the outbox adds `automation.run`.
 * - **Resume**: a `succeeded` step is reused like any other; a step that
 *   the delivery `failed` fails the run (no engine retry: the outbox
 *   already made its six attempts).
 */

/** What an HTTP action handler returns to send its request through the outbox. */
export interface HttpDeliveryWait {
  /** Rendered request; the engine adds the run's causation. */
  readonly request: Omit<HttpDeliveryRequest, 'causation' | 'signed'>;
  readonly authSecretId?: Id<'sec'> | null;
  readonly signingSecretId?: Id<'sec'> | null;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `delivery_id` of an HTTP step output, if any. */
export function deliveryIdOf(output: JsonValue | null | undefined): Id<'hdl'> | null {
  if (!isObject(output)) return null;
  const id = output['delivery_id'];
  return typeof id === 'string' && isId('hdl', id) ? id : null;
}

/** The outcome a final delivery gives its step. */
export type DeliveryStepOutcome =
  | { readonly status: 'succeeded'; readonly output: JsonObject }
  | {
      readonly status: 'failed';
      readonly error: { readonly code: string; readonly params: JsonObject };
    };

/** Output of a step whose delivery succeeded: `{ delivery_id, status, headers, body, body_truncated }`. */
export function deliveryStepOutput(row: Pick<HttpDeliveryRow, 'id' | 'response'>): JsonObject {
  const response = isObject(row.response) ? row.response : {};
  return { delivery_id: row.id, ...response };
}

/** The step outcome of a final delivery row (`null` while it is not final). */
export function deliveryOutcomeOf(row: HttpDeliveryRow): DeliveryStepOutcome | null {
  if (row.status === 'succeeded') return { status: 'succeeded', output: deliveryStepOutput(row) };
  if (row.status === 'failed' || row.status === 'cancelled') {
    const error = isObject(row.last_error) ? row.last_error : {};
    return {
      status: 'failed',
      error: {
        code: typeof error['code'] === 'string' ? error['code'] : 'internal_error',
        params: isObject(error['params']) ? error['params'] : {},
      },
    };
  }
  return null;
}

export interface ParkInput {
  readonly scope: OrgScope;
  readonly runId: Id<'run'>;
  readonly automationId: Id<'aut'>;
  readonly step: AutomationRunStepRow;
  readonly causation: Causation;
  readonly delivery: HttpDeliveryWait;
  readonly at: Date;
}

/**
 * Phase 1 in `tx`: delivery row + job, step `waiting` (`{ delivery_id }`),
 * run `waiting`. A row that already exists for the step (a job delivered
 * twice) is reused; if it is already final, the step is settled at once
 * and `settled` is `true` (the caller wakes the run). Throws
 * `OutboundHttpError` for a URL that can never be called.
 */
export async function parkOnDelivery(
  db: Db,
  outbox: HttpOutbox,
  tx: Tx,
  input: ParkInput,
): Promise<{ readonly deliveryId: Id<'hdl'>; readonly settled: boolean }> {
  const scope = withTxScope(input.scope, tx);
  const { row } = await outbox.enqueue(tx, scope, {
    kind: 'action',
    automationId: input.automationId,
    runId: input.runId,
    actionId: input.step.action_id,
    idempotencyKey: input.step.idempotency_key,
    request: { ...input.delivery.request, causation: input.causation },
    authSecretId: input.delivery.authSecretId ?? null,
    signingSecretId: input.delivery.signingSecretId ?? null,
  });
  await new AutomationRunStepsRepository(db).wait(scope, input.step.id, { delivery_id: row.id });
  await new AutomationRunsRepository(db).endSegment(scope, input.runId, {
    status: 'waiting',
    at: input.at,
    error: null,
  });
  const outcome = deliveryOutcomeOf(row);
  const settled =
    outcome !== null && (await settleDeliveryStep(db, tx, input.scope, row, outcome, input.at));
  return { deliveryId: row.id, settled };
}

/**
 * Phase 2 (the outbox's TX-b): finishes the `waiting` step of the
 * delivery's run with `outcome`. `false` when there is none any more (run
 * cancelled meanwhile: the result is dropped). The caller wakes the run.
 */
export async function settleDeliveryStep(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  row: Pick<HttpDeliveryRow, 'id' | 'run_id' | 'action_id'>,
  outcome: DeliveryStepOutcome,
  at: Date,
): Promise<boolean> {
  if (row.run_id === null || row.action_id === null) return false;
  const txScope = withTxScope(scope, tx);
  const steps = new AutomationRunStepsRepository(db);
  const step = await steps.findWaiting(txScope, row.run_id);
  if (step === undefined || step.action_id !== row.action_id) return false;
  if (deliveryIdOf(step.output) !== row.id) return false;
  if (outcome.status === 'succeeded') {
    await steps.finish(txScope, step.id, {
      status: 'succeeded',
      at,
      output: outcome.output,
      error: null,
    });
  } else {
    await steps.finish(txScope, step.id, {
      status: 'failed',
      at,
      error: { code: outcome.error.code, params: outcome.error.params, attempt: step.attempt },
    });
  }
  return true;
}

/**
 * The run's `waiting` step waits for a delivery (not a `delay`): the engine
 * leaves the run alone until the outbox wakes it.
 */
export function waitsForDelivery(step: AutomationRunStepRow | undefined): boolean {
  return step !== undefined && deliveryIdOf(step.output) !== null;
}

/**
 * A step the delivery `failed` (its output still names the delivery): the
 * run fails with the step's code — no engine retry.
 */
export function deliveryFailureOf(
  step: AutomationRunStepRow | undefined,
): { readonly code: string; readonly params: Readonly<Record<string, unknown>> } | null {
  if (step?.status !== 'failed' || deliveryIdOf(step.output) === null) return null;
  const error = isObject(step.error) ? step.error : {};
  return {
    code: typeof error['code'] === 'string' ? error['code'] : 'internal_error',
    params: isObject(error['params']) ? error['params'] : {},
  };
}

/**
 * Cancels the `pending` deliveries of runs being cancelled (T518 cancel,
 * automation turned off or deleted — `cancelWaitingRuns`): the destination
 * never receives them. A `sending` one finishes; its result is dropped.
 */
export async function cancelDeliveriesOfRuns(
  db: Db,
  scope: OrgScope,
  runIds: readonly Id<'run'>[],
): Promise<number> {
  return new HttpDeliveriesRepository(db).cancelPendingOfRuns(scope, runIds);
}
