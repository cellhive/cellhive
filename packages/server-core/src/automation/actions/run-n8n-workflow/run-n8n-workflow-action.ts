import { renderHttpRequest } from '../http-request/render.js';

import { buildN8nPayload, type N8nPayloadDeps } from './payload.js';

import type { JsonValue } from '../../../db/schema.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';
import type {
  HttpRequestConfig,
  N8nWorkflowPayload,
  RunN8nWorkflowConfig,
} from '@cellhive/contracts';

/**
 * The `http_request` a `run_n8n_workflow` step sends: `POST` of `payload`
 * as JSON, signed with its `webhook_signing` secret, failing on an HTTP
 * error. Shared by the run engine and "Send a test" (T616).
 */
export function n8nHttpRequestConfig(
  config: RunN8nWorkflowConfig,
  payload: N8nWorkflowPayload,
): HttpRequestConfig {
  return {
    method: 'POST',
    url: config.url,
    query: [],
    headers: [],
    auth: null,
    body: { type: 'json', value: { literal: payload as never } },
    signing_secret_id: config.signing_secret_id,
    fail_on_http_error: true,
  };
}

/**
 * The `run_n8n_workflow` handler of the run engine (SPEC §11.5, §13.3;
 * BACKLOG T607): a preset of `http_request`. It builds the SPEC §13.3
 * payload as `run_as` **now** (`buildN8nPayload`), then renders the request
 * exactly like `http_request` — `POST`, the URL with `url_component`
 * escaping, the payload as a JSON body (`application/json`; larger than
 * 1 MiB → `http_request_too_large`), the `webhook_signing` secret by id,
 * `fail_on_http_error: true` — and returns it as `{ delivery }`: the
 * engine parks the step on the outbox (`http-wait.ts`, T605), whose job
 * signs it (Standard Webhooks), adds `Idempotency-Key`,
 * `X-Cellhive-Causation` and `User-Agent`, and calls the destination. It
 * never calls the network.
 */
export function createRunN8nWorkflowAction(deps: N8nPayloadDeps): AutomationActionHandler {
  return {
    async execute(context: AutomationActionContext): Promise<AutomationActionResult> {
      const { action } = context;
      if (action.type !== 'run_n8n_workflow') {
        throw new TypeError('run_n8n_workflow handler: wrong action');
      }
      const built = await buildN8nPayload(deps, context, action.config);
      const rendered = await renderHttpRequest(
        context.values,
        n8nHttpRequestConfig(action.config, built.payload),
      );
      const warnings = [...built.warnings, ...rendered.warnings];
      return {
        output: warnings.length === 0 ? {} : { warnings: warnings as unknown as JsonValue },
        warnings,
        delivery: rendered.delivery,
      };
    },
  };
}
