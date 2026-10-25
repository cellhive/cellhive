import { createDelayAction } from './delay/delay-action.js';
import { createHttpRequestAction } from './http-request/http-request-action.js';
import { createIfAction } from './if/if-action.js';
import { createRecordActions, type RecordActionServices } from './record/record-actions.js';
import { createRunN8nWorkflowAction } from './run-n8n-workflow/run-n8n-workflow-action.js';
import { createUpdateRecordsAction } from './update-records/update-records-action.js';

import type { SchemaService } from '../../schema/schema.service.js';
import type {
  AutomationActionHandler,
  AutomationActionRegistry,
} from '../engine/action-registry.js';

/** Services of the default actions: record services, and `ANALYZE` for `update_records`. */
export interface DefaultActionServices extends RecordActionServices {
  readonly schema?: Pick<SchemaService, 'analyzeComputedTable'>;
}

/**
 * The action handlers of BACKLOG T505 — record actions and `if` — and T506
 * (`update_records`, `delay`). Later tasks pass theirs in `extra` (T514
 * `send_email` — `createSendEmailAction`, T515 `send_notification`, T516
 * `send_telegram` — `createSendTelegramAction`); an action type without a
 * handler fails its step with `unsupported_action`. `http_request` (T606)
 * only renders its request: the engine needs an `httpOutbox` to park it;
 * `run_n8n_workflow` (T607) is its preset with the SPEC §13.3 payload.
 */
export function defaultActionRegistry(
  services: DefaultActionServices,
  extra: Iterable<readonly [string, AutomationActionHandler]> = [],
): AutomationActionRegistry {
  return new Map<string, AutomationActionHandler>([
    ...createRecordActions(services),
    ['if', createIfAction(services.query)],
    ['update_records', createUpdateRecordsAction(services)],
    ['delay', createDelayAction(services.query)],
    ['http_request', createHttpRequestAction()],
    ['run_n8n_workflow', createRunN8nWorkflowAction({ query: services.query })],
    ...extra,
  ]);
}
