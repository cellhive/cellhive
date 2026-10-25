import { renderHttpRequest } from './render.js';

import type { JsonValue } from '../../../db/schema.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';

/**
 * The `http_request` handler of the run engine (SPEC §11.5, BACKLOG T606):
 * it renders the request as `run_as` **now** (`renderHttpRequest`) and
 * returns it as `{ delivery }` — it never calls the network. The engine
 * parks the step on a delivery row of the outbox in one transaction with
 * the run's causation (`http-wait.ts`, T605); the job `http.deliver` makes
 * the call, reads the secrets and signs it, then finishes the step.
 */
export function createHttpRequestAction(): AutomationActionHandler {
  return {
    async execute(context: AutomationActionContext): Promise<AutomationActionResult> {
      const { action } = context;
      if (action.type !== 'http_request') {
        throw new TypeError('http_request handler: wrong action');
      }
      const rendered = await renderHttpRequest(context.values, action.config);
      return {
        output:
          rendered.warnings.length === 0
            ? {}
            : { warnings: rendered.warnings as unknown as JsonValue },
        warnings: rendered.warnings,
        delivery: rendered.delivery,
      };
    },
  };
}
