import { z } from 'zod';

import { idOf } from '../../ids.js';
import {
  createIncomingWebhookRequestSchema,
  hookReceiveResponseSchema,
  INCOMING_WEBHOOK_TOKEN_PATTERN,
  incomingWebhookIdSchema,
  incomingWebhookListenResponseSchema,
  incomingWebhookSampleResponseSchema,
  incomingWebhookListSchema,
  incomingWebhookRequestListQuerySchema,
  incomingWebhookRequestListSchema,
  incomingWebhookSchema,
  incomingWebhookWithSecretsSchema,
  updateIncomingWebhookRequestSchema,
} from '../../incoming-webhooks.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const hookParams = z.object({ incomingWebhookId: incomingWebhookIdSchema });

const BASE_ADMIN_ONLY =
  '`PERMISSION_DENIED`: the caller can read the base but is not a base admin (incoming ' +
  'webhooks are managed by base admins only), or `CSRF_INVALID`';

const SHOWN_ONCE =
  'The secret in this response is shown once: it is never returned again (store it now).';

/** Incoming webhooks — management (CONTRACTS §25.1; BACKLOG T602, ADR-35 §1). */
export const registerIncomingWebhookRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };
  const tag = 'incoming-webhooks';

  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/incoming-webhooks',
    operationId: 'listIncomingWebhooks',
    tag,
    summary: 'List the incoming webhooks of a base',
    description: 'Base admins only. Deleted hooks are left out; ordered by creation.',
    params: baseParams,
    status: 200,
    response: incomingWebhookListSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/incoming-webhooks',
    operationId: 'createIncomingWebhook',
    tag,
    summary: 'Create an incoming webhook',
    description:
      'Base admins only. `auth` is required: `signature` issues a Standard Webhooks signing ' +
      'secret (`whsec_…`), `bearer` a Bearer token, `both` both, `none` neither. ' +
      `${SHOWN_ONCE} At most 50 hooks per base. Audited as \`incoming_webhook.created\` ` +
      '(configuration only).',
    params: baseParams,
    body: createIncomingWebhookRequestSchema,
    status: 201,
    response: incomingWebhookWithSecretsSchema,
    forbidden: BASE_ADMIN_ONLY,
    errors: {
      422:
        '`VALIDATION_FAILED`: malformed body or `errors[].code` `WEBHOOK_NAME_TAKEN` (path ' +
        '`name`), `TOO_MANY_WEBHOOKS`, `RATE_LIMIT_TOO_HIGH` (path `rate_limit_per_sec`, above ' +
        '`WEBHOOK_MAX_RATE_PER_SEC`)',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}',
    operationId: 'getIncomingWebhook',
    tag,
    summary: 'Read an incoming webhook (with its URL, never its secrets)',
    description:
      'Base admins only. `url` is decrypted for the caller; the signing secret and the Bearer ' +
      'token are never returned.',
    params: hookParams,
    status: 200,
    response: incomingWebhookSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'patch',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}',
    operationId: 'updateIncomingWebhook',
    tag,
    summary: 'Rename, enable/disable, change the rate limit or remove a check',
    description:
      'Base admins only. `auth` may only remove checks (the removed credential is erased); ' +
      'adding one goes through `rotate-secret` or `PUT …/bearer`. Audited as ' +
      '`incoming_webhook.updated`.',
    params: hookParams,
    body: updateIncomingWebhookRequestSchema,
    status: 200,
    response: incomingWebhookSchema,
    forbidden: BASE_ADMIN_ONLY,
    errors: {
      422:
        '`VALIDATION_FAILED`: malformed body or `errors[].code` `WEBHOOK_NAME_TAKEN`, ' +
        '`RATE_LIMIT_TOO_HIGH`, `CREDENTIAL_REQUIRED` (path `auth`)',
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}',
    operationId: 'deleteIncomingWebhook',
    tag,
    summary: 'Delete an incoming webhook',
    description:
      'Base admins only. Refused while automations (not deleted) are triggered by it. The URL ' +
      'stops answering at once (`404`). Audited as `incoming_webhook.deleted`.',
    params: hookParams,
    status: 204,
    forbidden: BASE_ADMIN_ONLY,
    errors: {
      409:
        '`WEBHOOK_IN_USE`: `errors[0].params = { usages: [{ automation_id, name | null }], ' +
        'total }` (a name only when the caller can see that automation)',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/rotate-secret',
    operationId: 'rotateIncomingWebhookSecret',
    tag,
    summary: 'Issue a new signing secret (the previous one stays valid 24 h)',
    description:
      'Base admins only. On a hook without signature check, turns it on (`none` → ' +
      '`signature`, `bearer` → `both`) with no previous secret. Otherwise the previous secret ' +
      `is accepted until \`signing_secret_rotating_until\`. ${SHOWN_ONCE} Audited as ` +
      '`incoming_webhook.secret_rotated`.',
    params: hookParams,
    status: 200,
    response: incomingWebhookWithSecretsSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'post',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/regenerate-token',
    operationId: 'regenerateIncomingWebhookToken',
    tag,
    summary: 'Replace the URL token (the old URL answers 404 at once)',
    description:
      'Base admins only. The response carries the new `url`. Audited as ' +
      '`incoming_webhook.token_regenerated`.',
    params: hookParams,
    status: 200,
    response: incomingWebhookSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'put',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/bearer',
    operationId: 'setIncomingWebhookBearer',
    tag,
    summary: 'Issue a new Bearer token (turns the Bearer check on)',
    description:
      'Base admins only. Replaces the current token at once (no grace period). ' +
      `${SHOWN_ONCE} Audited as \`incoming_webhook.updated\` (\`bearer_replaced\`).`,
    params: hookParams,
    status: 200,
    response: incomingWebhookWithSecretsSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'delete',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/bearer',
    operationId: 'deleteIncomingWebhookBearer',
    tag,
    summary: 'Turn the Bearer check off',
    description: 'Base admins only. Audited as `incoming_webhook.updated`.',
    params: hookParams,
    status: 200,
    response: incomingWebhookSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'get',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/requests',
    operationId: 'listIncomingWebhookRequests',
    tag,
    summary: 'Log of received requests (metadata only)',
    description:
      'Base admins only. Newest first, cursor-paginated; kept 7 days. Never bodies or headers.',
    params: hookParams,
    query: incomingWebhookRequestListQuerySchema,
    status: 200,
    response: incomingWebhookRequestListSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'post',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/listen',
    operationId: 'listenIncomingWebhookSample',
    tag,
    summary: 'Listen for a sample request (180 s)',
    description:
      'Base admins only. Opens (or replaces) the window and drops the previous sample: the ' +
      'first valid request received before `listen_until` is stored as the sample (body up to ' +
      '64 KB, sensitive headers removed) and closes the window. The caller gets the realtime ' +
      'message `incoming_webhook.sample_captured` on `user:<id>`. The sampled request is still ' +
      'processed normally (it triggers automations).',
    params: hookParams,
    status: 200,
    response: incomingWebhookListenResponseSchema,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'delete',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/listen',
    operationId: 'stopListeningIncomingWebhookSample',
    tag,
    summary: 'Stop listening for a sample request',
    description: 'Base admins only. Keeps a sample already captured.',
    params: hookParams,
    status: 204,
    forbidden: BASE_ADMIN_ONLY,
  });
  add({
    method: 'get',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/sample',
    operationId: 'getIncomingWebhookSample',
    tag,
    summary: 'Read the sample request',
    description:
      'Base admins only. `sample` is `null` until a request was captured; never carries ' +
      '`authorization`, `cookie`, `webhook-signature` or `x-cellhive-causation`.',
    params: hookParams,
    status: 200,
    response: incomingWebhookSampleResponseSchema,
    forbidden: BASE_ADMIN_ONLY,
  });

  // The public route takes JSON or form bodies, so it is registered by hand.
  registry.registerPath({
    method: 'post',
    path: '/api/v1/hooks/{token}',
    operationId: 'receiveIncomingWebhook',
    tags: [tag],
    summary: 'Receive a request on an incoming webhook (public)',
    description:
      'Public: authorised by the URL token and, as the hook is configured, `Authorization: ' +
      'Bearer <token>` and/or a Standard Webhooks signature (`webhook-id`, `webhook-timestamp` ' +
      'within 300 s, `webhook-signature`; CONTRACTS §10). Checks in order: 20 requests/s per ' +
      'IP, the token, the hook (enabled, base not in the trash), the hook rate limit ' +
      '(`rate_limit_per_sec`, burst 4×) and 50 requests/s per base, the body (≤ 1 MiB, ' +
      '`application/json` object or array, or `application/x-www-form-urlencoded`; empty = ' +
      '`null`), then the credentials. The request is stored and `202` returned at once; ' +
      'automations run from the `webhook.received` event. A `webhook-id` already received ' +
      '(7 days) is `202` without a new event. A valid `X-Cellhive-Causation` header (sent by ' +
      'Cellhive `http_request` / `run_n8n_workflow`, directly or forwarded unchanged by n8n or ' +
      'another system; bound to this instance, not to one hook) continues the loop guard ' +
      'chain. `Idempotency-Key` is ignored.',
    security: [{}],
    request: {
      params: z.object({
        token: z.string().regex(INCOMING_WEBHOOK_TOKEN_PATTERN).meta({
          description: 'The 43-character URL token',
        }),
      }),
      body: {
        required: false,
        content: {
          'application/json': {
            schema: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
          },
          'application/x-www-form-urlencoded': { schema: z.record(z.string(), z.string()) },
        },
      },
    },
    responses: {
      202: {
        description: 'Accepted',
        content: { 'application/json': { schema: hookReceiveResponseSchema } },
      },
      400: problem(
        '`MALFORMED_JSON`: the JSON body is invalid, not an object or array, or holds a NUL character or a lone surrogate',
      ),
      401: problem(
        '`UNAUTHENTICATED`: Bearer token or signature missing or wrong (no reason given)',
      ),
      404: problem('`NOT_FOUND`: unknown token, disabled or deleted hook, or base in the trash'),
      413: problem('`PAYLOAD_TOO_LARGE`: body over 1 MiB'),
      415: problem('`UNSUPPORTED_MEDIA_TYPE`: neither JSON nor form'),
      429: problem('`RATE_LIMITED` with `Retry-After`: per IP, per hook or per base'),
      503: problem(
        '`DEPENDENCY_UNAVAILABLE` with `Retry-After: 1`: the rate limiter is unavailable',
      ),
    },
  });
};
