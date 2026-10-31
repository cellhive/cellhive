import { z } from 'zod';

import { aiFormulaRequestSchema, aiFormulaSchema } from '../../ai-formula.js';
import {
  aiSettingsSchema,
  aiSettingsTestResultSchema,
  aiUsageQuerySchema,
  aiUsageSchema,
  testAiSettingsRequestSchema,
  updateAiSettingsRequestSchema,
} from '../../ai-settings.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const tableParams = z.object({ tableId: idOf('tbl') });

const ADMIN_ONLY =
  '`PERMISSION_DENIED`: the caller is a member but not an owner/admin of the organization ' +
  '(workspace and base admins included), or `CSRF_INVALID`; `INSUFFICIENT_SCOPE` with an API ' +
  'token (session only)';

const AI_LIMITED =
  '`RATE_LIMITED` with `Retry-After`: more than 10 AI requests a minute, or 2 at once, ' +
  'by the user (8 at once on the instance); `AI_QUOTA_EXCEEDED` with `Retry-After` and ' +
  '`errors[0].params.reset_at`: the daily token quota is used up';

/**
 * AI settings, quota and usage of an organization (CONTRACTS §29.1; BACKLOG
 * T906, ADR-39) and the AI feature routes (§29.2–; T907–).
 */
export const registerAiRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/ai-settings',
    operationId: 'getAiSettings',
    tag: 'ai',
    summary: 'AI settings of an organization',
    description:
      'Organization owner/admin only. The defaults until first saved; the API key as its ' +
      'secret (id, name, allowed hosts), never its value.',
    params: orgParams,
    status: 200,
    response: aiSettingsSchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'put',
    path: '/api/v1/orgs/{orgId}/ai-settings',
    operationId: 'updateAiSettings',
    tag: 'ai',
    summary: 'Change the AI provider, the key, data access and the daily quota',
    description:
      'Organization owner/admin only; keys left out keep their value. `api_key: { value }` ' +
      'stores the key as an `ai_api_key` secret bound to the host (and port) of ' +
      '`provider_base_url` in the same transaction — a later URL on another host never ' +
      'receives it (`secret_host_not_allowed`). A new provider URL or model clears ' +
      '`detected_output`. Audited as `ai_settings.updated` (never the key; ' +
      '`allow_record_data` changes are named).',
    params: orgParams,
    body: updateAiSettingsRequestSchema,
    status: 200,
    response: aiSettingsSchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422:
        '`VALIDATION_FAILED`: malformed body or `errors[].code` `RECORD_DATA_NOT_CONFIRMED` ' +
        '(path `confirm`), `INVALID_URL` (path `provider_base_url`, `params.reason`), ' +
        '`REQUIRED` (a key without a provider URL), `INVALID_SECRET_VALUE` (path ' +
        '`api_key.value`), `SECRET_HOST_NOT_ALLOWED` (path `api_key`: an IP address cannot ' +
        'hold a key), `UNKNOWN_SECRET` (path `api_key.secret_id`)',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/ai-settings/test',
    operationId: 'testAiSettings',
    tag: 'ai',
    summary: 'Try the provider: models, structured output, latency',
    description:
      'Organization owner/admin only. The saved settings, or unsaved ones in `settings`: ' +
      '`GET /models`, then a small call with an enum schema from the configured rung down ' +
      'until one answers correctly. A failed call is a result (`ok: false`, `error`), not an ' +
      'HTTP error. With `structured_output: auto` and the saved provider, the rung found is ' +
      'saved as `detected_output`. Counts towards the quota (feature `test`), the rate limit ' +
      'of AI requests, and is audited as `ai.requested`.',
    params: orgParams,
    body: testAiSettingsRequestSchema,
    bodyOptional: true,
    status: 200,
    response: aiSettingsTestResultSchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422: '`VALIDATION_FAILED` (as `PUT`), or `AI_NOT_CONFIGURED`: no provider URL or no model',
      429: AI_LIMITED,
    },
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/ai-usage',
    operationId: 'getAiUsage',
    tag: 'ai',
    summary: 'Tokens used per day and feature, and the quota',
    description:
      'Organization owner/admin only. Days in the organization time zone, at most 90; kept ' +
      '400 days.',
    params: orgParams,
    query: aiUsageQuerySchema,
    status: 200,
    response: aiUsageSchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422:
        '`VALIDATION_FAILED`: a malformed date, or `OUT_OF_RANGE` (path `from`): `from` after ' +
        '`to`, or more than 90 days',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/tables/{tableId}/ai/formula',
    operationId: 'generateAiFormula',
    tag: 'ai',
    summary: 'Write a formula from a description',
    description:
      'Needs schema rights on the table like `POST /tables/{tableId}/computed-preview` (a ' +
      'reader of the table without them gets `403`, anyone else `404`, before anything about ' +
      'AI). The model sees only the tables and fields the caller reads (never values or ids) ' +
      'and answers with a formula, checked exactly like a save for the caller (a field they ' +
      'cannot read is a field that does not exist); errors go back to the model, at most 2 ' +
      'repair rounds. Nothing is stored: put the formula in the editor, preview it with ' +
      '`computed-preview`, save it with the field routes. Counts towards the quota (feature ' +
      '`formula`) and the AI rate limit; audited as `ai.requested` (CONTRACTS §29.2).',
    params: tableParams,
    body: aiFormulaRequestSchema,
    status: 200,
    response: aiFormulaSchema,
    errors: {
      422:
        '`VALIDATION_FAILED`; `AI_NOT_CONFIGURED`: AI is off or has no provider; ' +
        '`AI_INVALID_OUTPUT` (`errors[0].params.attempts`): still no valid formula after 2 ' +
        'repair rounds',
      429: AI_LIMITED,
      502: '`AI_PROVIDER_ERROR` (`errors[0].params.reason`): the provider failed',
      504: '`AI_TIMEOUT`: no valid answer within the 90 s budget of the request',
    },
  });
};
