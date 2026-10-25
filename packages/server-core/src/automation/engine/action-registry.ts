import type { HttpDeliveryWait } from './http-wait.js';
import type { AuditContext } from '../../audit/audit-entry.js';
import type { Db, Tx } from '../../db/create-db.js';
import type { OrgScope } from '../../db/repository.js';
import type { JsonObject } from '../../db/schema.js';
import type { Causation } from '../../events/event.js';
import type { MemberBaseAccess } from '../../import/member-access.js';
import type { AutomationValidationContext } from '../definition/validate.js';
import type { AutomationValueEvaluator, TemplateWarning } from '../values/evaluator.js';
import type {
  AutomationAction,
  AutomationBranchAction,
  AutomationRunSkipCode,
  Id,
} from '@cellhive/contracts';

/**
 * Action handlers of the run engine (SPEC §11.5, BACKLOG T505). The engine
 * owns the step lifecycle (idempotency key, attempts, retries, timeout,
 * run status); a handler only performs its action as `run_as` and returns
 * the step output. Record actions and `if` are T505; `update_records` and
 * `delay` (T506: progress, waiting, skipping), `send_email` (T514), `send_notification` (T515) and
 * `send_telegram` (T516) register their own handler in
 * {@link AutomationActionRegistry} — an action type without one fails its
 * step with `unsupported_action`.
 */

/** The run being executed, as handlers see it. */
export interface AutomationRunInfo {
  readonly id: Id<'run'>;
  readonly automationId: Id<'aut'>;
  readonly baseId: Id<'bse'>;
  /** Trigger table and record (`null` without record, e.g. `schedule`). */
  readonly triggerTableId: Id<'tbl'> | null;
  readonly triggerRecordId: Id<'rec'> | null;
  readonly triggerEventId: Id<'evt'> | null;
  /** `record.created`, `record.deleted`, `form.submitted`… (the event type for event triggers). */
  readonly triggerType: string;
  /** Organization zone and locale (ADR-21). */
  readonly timeZone: string;
  readonly locale: string;
  /** `created_at` of the trigger event (ISO), to read it again (`run_n8n_workflow`, T607). */
  readonly triggerEventCreatedAt?: string | null;
  /** Names of the automation and its base when the run started (`run_n8n_workflow`, T607). */
  readonly automationName?: string;
  readonly baseName?: string;
}

export interface AutomationActionContext<
  A extends AutomationAction | AutomationBranchAction = AutomationAction | AutomationBranchAction,
> {
  readonly db: Db;
  readonly scope: OrgScope;
  readonly run: AutomationRunInfo;
  readonly action: A;
  /** Effective access of `run_as` **now** (ADR-25 §1). */
  readonly access: MemberBaseAccess;
  /** Schema of the base as `run_as` sees it (what values and templates resolve against). */
  readonly schema: AutomationValidationContext;
  readonly values: AutomationValueEvaluator;
  /** `actor_type = automation`, `via = { automation_id, run_id }`, `batch_id = run_…` (ADR-26 §1). */
  readonly audit: AuditContext;
  /** Loop guard of the writes: depth + 1, automation appended to the chain (SPEC §11.6). */
  readonly causation: Causation;
  /** `automation_id:trigger_event_id:action_id` (SPEC §11.7): headers, Message-ID… */
  readonly idempotencyKey: string;
  /** 1 for the first attempt of the step. */
  readonly attempt: number;
  /**
   * Output the step stored before this attempt (`null` the first time):
   * progress of `update_records` saved by an attempt that failed, `until`
   * of a `delay` that is resuming (T506).
   */
  readonly previous: JsonObject | null;
  /** Engine clock (tests pin it). */
  now(): Date;
  /**
   * Saves `output` as the progress of the step, still `running`, inside
   * `tx` — the transaction of the batch it describes (T506
   * `update_records`): a retry reads it back as {@link previous}.
   */
  saveProgress(tx: Tx, output: JsonObject): Promise<void>;
  /**
   * Marks the step `succeeded` with `output` inside `tx` — the transaction
   * of the side effect — so a crash can never leave the effect without the
   * step (a resumed run would do it twice). Call it last in that
   * transaction (`RecordMutationService` `beforeCommit`/`onCreated`).
   */
  complete(tx: Tx, output: JsonObject): Promise<void>;
}

export interface AutomationActionResult {
  /** Step output (JSON, record cells by field id; never logged). */
  readonly output: JsonObject;
  readonly warnings?: readonly TemplateWarning[];
  /** `if` only: the branch to run next, or `stop` (the run ends `succeeded`). */
  readonly branch?: 'then' | 'else' | 'stop';
  /**
   * `delay` only (T506): wait until this instant — the step goes `waiting`
   * with `output`, the run `waiting` (no worker held, not running time), and
   * `automation.run` is scheduled for then; the step runs again with
   * `previous = output` when it is due.
   */
  readonly wait?: { readonly until: Date };
  /**
   * `delay` only (T506): end the run `skipped` with this reason (the step is
   * `skipped` with `output`); the remaining steps do not run.
   */
  readonly skip?: {
    readonly code: AutomationRunSkipCode;
    readonly params?: Readonly<Record<string, unknown>>;
  };
  /**
   * HTTP actions only (T605, ADR-35 §4): send this request through the
   * outbox instead of calling the network here — the engine parks the step
   * `waiting` (`{ delivery_id }`) and the run `waiting`; the delivery
   * finishes the step and wakes the run (`http-wait.ts`).
   */
  readonly delivery?: HttpDeliveryWait;
}

export interface AutomationActionHandler {
  execute(context: AutomationActionContext): Promise<AutomationActionResult>;
}

/** Handlers by action type (`AutomationActionType`, and the types later tasks add). */
export type AutomationActionRegistry = ReadonlyMap<string, AutomationActionHandler>;
