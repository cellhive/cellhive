export { checkAutomationTemplate, type AutomationTemplateCheck } from './check.js';
export { moreRecordsLine } from './digest-text.js';
export { eventActorId, previousCell, previousValues } from './event-data.js';
export {
  endsInsideTag,
  escapeHeader,
  escapePlain,
  escapeTelegramAttribute,
  escapeTelegramHtml,
  escapeValue,
  finishText,
  truncateText,
} from './escape.js';
export {
  AutomationValueError,
  AutomationValueEvaluator,
  MAX_LINKED_RECORDS,
  refusedFunctionsIn,
  type AutomationRecordReader,
  type AutomationValueEvaluatorOptions,
  type RenderedText,
  type RenderOptions,
  type ResolvedValue,
  type TemplateWarning,
} from './evaluator.js';
export { recordQueryReader } from './record-reader.js';
export {
  isWebhookReference,
  webhookPartValue,
  webhookReferenceText,
  webhookReferencesIn,
  webhookTemplateText,
  withWebhookReferences,
  type WebhookRequestData,
} from './webhook-data.js';
export { automationSnapshot, NO_RECORD_TABLE, stepFieldsOf } from './snapshot.js';
export { templateResultType } from '@cellhive/formula-engine';
export {
  definitionSources,
  PREVIOUS_RECORD_ID,
  previousSourceOf,
  NO_TEMPLATE_SOURCES,
  RECORD_ID_REFERENCE,
  RECORD_URL_REFERENCE,
  stepRecordId,
  stepRecordTable,
  TRIGGER_REFERENCES,
  type TemplateSources,
} from './references.js';
