/**
 * The AI core (CONTRACTS §29.7, ADR-39): the Chat Completions client over the
 * SSRF core, the structured-output ladder, repair rounds, the request
 * deadline and untrusted data blocks; the AI settings, quota ledger, audit
 * and metrics shared by the API and the worker (T906). The fake provider for tests is in
 * `@cellhive/server-core/testing`, never loaded at runtime.
 */
export {
  AI_USER_AGENT,
  estimateTokens,
  LlmClient,
  type AiChatMessage,
  type AiCompleteRequest,
  type AiCompletion,
  type AiJsonOutput,
  type AiKeySource,
  type AiOutput,
  type AiProviderSettings,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage,
  type LlmClientOptions,
} from './client.js';
export {
  AI_REQUEST_BUDGET_MS,
  createDeadline,
  remainingOrTimeout,
  type AiDeadline,
} from './deadline.js';
export { aiInvalidOutput, aiProviderError, aiTimeout, isTemporaryAiError } from './errors.js';
export {
  dropNullOptionals,
  LLM_SCHEMA_MAX_DEPTH,
  llmJsonSchema,
  type JsonSchemaNode,
  type LlmJsonSchema,
} from './json-schema.js';
export {
  AI_OUTPUT_MODES,
  extractJsonObject,
  lowerOutputMode,
  responseFormatOf,
  schemaInstruction,
  SCHEMA_INSTRUCTION_LEAD,
  type AiOutputMode,
} from './output.js';
export {
  AI_MAX_REPAIR_ROUNDS,
  MAX_REPAIR_PROBLEMS,
  repairMessage,
  zodProblems,
  type AiOutputProblem,
  type AiValidation,
} from './repair.js';
export { DATA_MARK, UNTRUSTED_DATA_INSTRUCTIONS, untrustedBlock } from './untrusted.js';
export {
  aiRequestedAfter,
  truncateUtf8,
  writeAiRequestedAudit,
  type AiRequestedEntry,
} from './audit/ai-requested.js';
export {
  AUTOMATION_DIGEST_MAX_TABLES,
  AUTOMATION_DRAFT_ACTION_TYPES,
  AUTOMATION_DRAFT_TRIGGER_TYPES,
  automationDigestJson,
  automationDigestTableIds,
  automationDraftDigest,
  automationDraftMessages,
  automationDraftSchema,
  automationDraftTypes,
  automationValidationProblems,
  compileAutomationDraft,
  type AutomationDraft,
  type AutomationDraftDigest,
  type AutomationDraftSources,
  type AutomationDraftView,
} from './features/automation/automation.js';
export {
  aiFormulaAnswerSchema,
  FORMULA_DIGEST_MAX_DESCRIPTION,
  FORMULA_DIGEST_MAX_FIELDS,
  FORMULA_DIGEST_MAX_OPTIONS,
  FORMULA_DIGEST_MAX_TABLES,
  formulaCatalogueText,
  formulaDigest,
  formulaMessages,
  formulaRepairProblems,
  type AiFormulaAnswer,
  type FormulaDigest,
} from './features/formula/formula.js';
export {
  aggregatePlanOfAsk,
  askDigest,
  askDigestJson,
  askInterpretation,
  askMessages,
  askPlanSchema,
  askProblems,
  askResultJson,
  narrativeMessages,
  type AskDigest,
  type AskDigestField,
  type AskPlan,
} from './features/ask/ask.js';
export {
  aiQuotaExhaustedCount,
  aiRequestCounts,
  aiRetryCounts,
  aiTokenCounts,
  observeAiDurations,
  recordAiQuotaExhausted,
  recordAiRequest,
  type AiRequestOutcome,
  type AiRequestStatus,
} from './metrics.js';
export { AiSettingsRepository, type AiSettingsValues } from './settings/ai-settings.repository.js';
export { createAiKeySource, transientAiKeySource } from './settings/key-source.js';
export {
  aiNotConfigured,
  DEFAULT_AI_SETTINGS,
  defaultTokenParam,
  isAiAvailable,
  keyHostPatternOf,
  organizationAiOf,
  providerSettingsOf,
  requireAi,
  type AiSettingsState,
} from './settings/settings.js';
export { AiUsageRepository, type AiUsageDay } from './usage/ai-usage.repository.js';
export {
  aiQuotaExceeded,
  AiUsageLedger,
  quotaDayOf,
  type AiQuotaContext,
  type QuotaDay,
} from './usage/quota.js';
export {
  aiOptionsForReader,
  prepareAiOptions,
  type AiFieldContext,
} from './generation/definition.js';
export { AiGenerationEnqueuer } from './generation/enqueue-changes.js';
export {
  aiFailureReason,
  AiFieldGenerator,
  aiSystemAccess,
  aiTargetOf,
  generateAiValue,
  type AiBatchOutcome,
  type AiFieldGeneratorOptions,
  type AiFieldStateChange,
  type AiValueCall,
} from './generation/generator.js';
export {
  AI_GENERATE_DEBOUNCE_MS,
  aiGenerateJobKey,
  enqueueAiGeneration,
} from './generation/jobs.js';
export {
  AI_FIELD_TYPES,
  aiOptionsOf,
  aiSourceFieldIds,
  aiSourcesOf,
  isAiField,
} from './generation/options.js';
export {
  aiFieldMessages,
  AiRenderError,
  aiSelectAnswerSchema,
  aiTextValue,
  renderAiInput,
  type AiFieldTarget,
  type RenderContext,
  type RenderedAiInput,
} from './generation/prompt.js';
export { AiGenerationQueueRepository, type TakenAiRow } from './generation/queue.repository.js';
export {
  aiAnalysisOf,
  aiCrossRecordSources,
  aiFieldLockedFor,
  aiReadFieldIds,
  loadAiLockRule,
  type AiLockRule,
} from './generation/sources.js';
