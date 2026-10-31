/**
 * The AI core (CONTRACTS §29.7, ADR-39): the Chat Completions client over the
 * SSRF core, the structured-output ladder, repair rounds, the request
 * deadline and untrusted data blocks. The fake provider for tests is in
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
