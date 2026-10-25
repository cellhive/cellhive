export {
  flattenActions,
  validateAutomationDefinition,
  type AutomationFieldMeta,
  type AutomationTableMeta,
  type AutomationValidation,
  type AutomationValidationContext,
  type AutomationViewMeta,
} from './definition/validate.js';
export {
  canManageAutomation,
  canSeeAutomation,
  managedTableIds,
  managesAnyAutomation,
} from './permissions/manage.js';
export {
  AutomationsRepository,
  type AutomationListFilter,
  type AutomationListRow,
  type InsertAutomationInput,
  type UpdateAutomationInput,
} from './repository/automations.repository.js';
export {
  AutomationRunsRepository,
  BATCH_FANOUT_EXCEEDED,
  type AutomationRunStats,
  type InsertRunInput,
  type RecentUnits,
  type RunLogFilter,
  type RunLogRow,
  type UnitOutcome,
} from './repository/automation-runs.repository.js';
export {
  actionsOf,
  AutomationRunLog,
  runDefinitionOf,
  type RunAction,
  type RunLogActor,
  type RunLogDetail,
} from './runs/run-log.js';
export {
  delayUntilRecordRefs,
  delayUntilVisible,
  HTTP_OUTPUT_ACTION_TYPES,
  redactStepOutput,
  stepRecordRefs,
  VALUE_OUTPUT_ACTION_TYPES,
  valuesRecordRefs,
  valuesVisible,
  type DelayUntilContext,
  type RedactedOutput,
  type StepReadability,
  type StepRecordRefs,
} from './runs/redact.js';
export {
  AUTOMATION_RUNS_CLEANUP_BATCH,
  AUTOMATION_RUNS_CLEANUP_ORG_PAGE,
  purgeExpiredAutomationRuns,
  type AutomationRunsCleanupResult,
} from './runs/retention.js';
export { AutomationBatchCountersRepository } from './repository/batch-counters.repository.js';
export {
  BREAKER_MAX_FAILED_UNITS,
  BREAKER_MAX_UNITS_PER_MINUTE,
  BREAKER_WINDOW_SECONDS,
  tripCircuitBreaker,
  tripOnConsecutiveFailures,
} from './dispatch/circuit-breaker.js';
export {
  changeConditionsOf,
  foldChangeConditions,
  type FoldedCondition,
} from './dispatch/condition.js';
export {
  AutomationDispatcher,
  DEFAULT_MAX_RUNS_PER_BATCH,
  type AutomationDispatcherOptions,
  type AutomationDispatchOutcome,
  type AutomationDispatchResult,
  type DispatchResult,
} from './dispatch/dispatcher.js';
export {
  DISPATCHED_TRIGGERS,
  isBulkEvent,
  triggerMismatch,
  triggerRecordIdOf,
  triggerTypeFor,
  triggerTypesFor,
  triggerUnitOf,
  webhookIdOf,
  webhookTriggerUnit,
  type TriggerMismatch,
} from './dispatch/event-match.js';
export {
  conditionFieldIdsOf,
  MATCHES_EVENT_TYPES,
  planTransition,
  transitionImagesOf,
  withLaterChanges,
  type TransitionPlan,
} from './dispatch/matches/transition.js';
export {
  recomputeJobBatchId,
  RecomputeEventHooks,
  type RecomputeEventHooksOptions,
} from './dispatch/recompute-events.js';
export { automationMaxDepthOf, loopGuard, type LoopGuardVerdict } from './dispatch/loop-guard.js';
export {
  AUTOMATION_NOTIFICATIONS,
  NO_AUTOMATION_NOTIFICATIONS,
  type AutomationBatchOverflowNotice,
  type AutomationDisabledNotice,
  type AutomationNotifier,
} from './dispatch/notifier.js';
export * from './values/index.js';
export {
  AutomationRunStepsRepository,
  type BeginStepInput,
} from './repository/automation-run-steps.repository.js';
export { type EndSegmentInput } from './repository/automation-runs.repository.js';
export {
  AUTOMATION_ORG_SLOT,
  AutomationRunEngine,
  automationWaitJobKey,
  DEFAULT_MAX_RUNNING_PER_ORG,
  NO_RUN_AS_ACCESS_CHECK,
  stepIdempotencyKey,
  type AutomationRunEngineOptions,
  type RunAsAccessCheck,
  type RunEngineResult,
  untilOf,
} from './engine/run-engine.js';
export { cancelWaitingRun, cancelWaitingRuns } from './engine/cancel.js';
export {
  deliveryIdOf,
  deliveryOutcomeOf,
  type DeliveryStepOutcome,
  type HttpDeliveryWait,
} from './engine/http-wait.js';
export { disableAutomationBySystem, type SystemDisableOptions } from './engine/system-disable.js';
export * from './revalidate/index.js';
export {
  CAUSATION_HOOK_PATH_PREFIX,
  CAUSATION_TOKEN_PREFIX,
  CAUSATION_TOKEN_TTL_S,
  causationTarget,
  decodeCausationToken,
  deriveCausationKey,
  encodeCausationToken,
  type CausationTokenFailure,
  type CausationTokenResult,
  type DecodeCausationOptions,
  type EncodeCausationOptions,
} from './causation/token.js';
export {
  AutomationStepError,
  classifyStepError,
  retryDelayMs,
  type PermissionScope,
  type StepFailure,
  type StepWait,
} from './engine/errors.js';
export type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionRegistry,
  AutomationActionResult,
  AutomationRunInfo,
} from './engine/action-registry.js';
export { automationSchemaOf, loadAutomationSchema } from './engine/schema-context.js';
export { defaultActionRegistry, type DefaultActionServices } from './actions/registry.js';
export {
  createUpdateRecordsAction,
  type UpdateRecordsServices,
} from './actions/update-records/update-records-action.js';
export { filterValueSlots, type FilterValueSlot } from './actions/update-records/filter-values.js';
export { filterOperandOf } from './actions/update-records/operands.js';
export { createDelayAction } from './actions/delay/delay-action.js';
export { parseUntil } from './actions/delay/until.js';
export { createRecordActions, type RecordActionServices } from './actions/record/record-actions.js';
export { createIfAction } from './actions/if/if-action.js';
export { compareIfValues, isEmptyValue, type IfValueOperator } from './actions/if/compare.js';
export * from './actions/send-email/index.js';
export * from './actions/http-request/index.js';
export * from './actions/run-n8n-workflow/index.js';
export { AutomationTimeCursorsRepository } from './repository/time-cursors.repository.js';
export {
  fireTimesBetween,
  latestFireTime,
  MIN_SCHEDULE_INTERVAL_MINUTES,
  minIntervalMinutes,
  nextFireTime,
  parseCron,
  type CronFieldName,
  type CronParseResult,
  type CronSchedule,
} from './time/cron.js';
export { dueAt, firstTimeZone, valueRangeOf, type DueRule } from './time/due.js';
export {
  AutomationTimeTriggers,
  DATE_SCAN_PAGE,
  SCHEDULE_MISSED_COUNT_LIMIT,
  TIME_TRIGGER_PAGE,
  type AutomationTimeTriggersOptions,
  type TimeTriggerOutcome,
  type TimeTriggerResult,
  type TimeTriggerTick,
} from './time/time-triggers.js';
export * from './actions/send-notification/index.js';
export * from './actions/send-telegram/index.js';
export {
  buttonAutomationOf,
  buttonGateOf,
  type ButtonAutomation,
  type ButtonClickedTrigger,
} from './triggers/button/button-trigger.js';
export {
  ButtonClickService,
  buttonDisabled,
  type ButtonClickInput,
  type ButtonClickResult,
  type ButtonClickServiceOptions,
} from './triggers/button/button-click.service.js';
export { clickedByOf, publishButtonRunFinished } from './triggers/button/run-finished.js';
export {
  DUPLICATE_NAME_SUFFIXES,
  duplicateAutomationName,
  emailAssetReferencesOf,
  replaceEmailAssetIds,
  type EmailAssetReference,
} from './duplicate/duplicate.js';
