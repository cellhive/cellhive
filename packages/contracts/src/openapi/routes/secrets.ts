import { z } from 'zod';

import { idOf } from '../../ids.js';
import {
  baseSecretListQuerySchema,
  baseSecretListSchema,
  createSecretRequestSchema,
  secretIdSchema,
  secretListSchema,
  secretUsagesSchema,
  secretWithValueSchema,
  updateSecretRequestSchema,
} from '../../secrets.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const secretParams = z.object({ secretId: secretIdSchema });
const baseParams = z.object({ baseId: idOf('bse') });

const ADMIN_ONLY =
  '`PERMISSION_DENIED`: the caller is a member but not an owner/admin of the organization ' +
  '(workspace and base admins included), or `CSRF_INVALID`';

const SAVE_ERRORS =
  '`VALIDATION_FAILED`: malformed body or `errors[].code` `SECRET_NAME_TAKEN`, ' +
  '`INVALID_BOT_TOKEN` (not a Telegram bot token), `INVALID_SECRET_VALUE` (an `http_header` ' +
  'value that is not printable ASCII ≤ 4,096, a `webhook_signing` value that is not ' +
  '`whsec_` + 24–64 bytes, or `generate` for another kind), `UNKNOWN_BASE`, ' +
  '`SECRET_LIMIT_REACHED`, `SECRET_HOSTS_REQUIRED` (an HTTP secret without `allowed_hosts`, ' +
  'or `[]`), `TOO_MANY_ALLOWED_HOSTS` (> 20), `INVALID_ALLOWLIST_PATTERN` ' +
  '(`allowed_hosts[i]`), `UNRECOGNIZED_KEY` (`allowed_hosts` of a `telegram_bot`)';

/** Organization secrets (CONTRACTS §24; BACKLOG T516, T606). */
export const registerSecretRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/secrets',
    operationId: 'listSecrets',
    tag: 'secrets',
    summary: 'List the secrets of an organization',
    description: 'Organization owner/admin only. Names, kinds and scopes — never the values.',
    params: orgParams,
    status: 200,
    response: secretListSchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/secrets',
    operationId: 'createSecret',
    tag: 'secrets',
    summary: 'Store a secret (a Telegram bot token, an HTTP header value, a signing secret)',
    description:
      'Organization owner/admin only. The value is sealed with AES-256-GCM and never returned, ' +
      'logged or audited — except a `webhook_signing` value the server generated ' +
      '(`generate: true`), returned once in `value`. `http_header` / `webhook_signing` need ' +
      '`allowed_hosts`: automations send them only to those hosts (T701). Audited as ' +
      '`secret.created` (name, kind, scope, allowed hosts).',
    params: orgParams,
    body: createSecretRequestSchema,
    status: 201,
    response: secretWithValueSchema,
    forbidden: ADMIN_ONLY,
    errors: { 422: SAVE_ERRORS },
  });
  add({
    method: 'patch',
    path: '/api/v1/secrets/{secretId}',
    operationId: 'updateSecret',
    tag: 'secrets',
    summary: 'Rename a secret, change its base scope or replace its value',
    description:
      'Organization owner/admin only. Automations are not changed: a `send_telegram` step of a ' +
      'base the new scope leaves out fails with `secret_unavailable`. Audited as ' +
      '`secret.updated` (`value_replaced: true`, never the value). A new token of the ' +
      "organization's notification bot that names another bot is checked with `getMe` " +
      '(`INVALID_BOT_TOKEN` when refused, `503` without answer; `BOT_IN_USE` when that bot ' +
      'is the notification bot of another organization) and puts every personal ' +
      'Telegram channel in `error` (`bot_changed`, T549). A new value of a `webhook_signing` ' +
      'secret (or `generate: true`, returned once in `value`) keeps the previous one signing ' +
      'for 24 hours (`previous_value_expires_at`, T606). `allowed_hosts` replaces the hosts of ' +
      'an HTTP secret and ends the transition period of one stored before lists existed ' +
      '(`legacy_hosts_until` → `null`, T701).',
    params: secretParams,
    body: updateSecretRequestSchema,
    status: 200,
    response: secretWithValueSchema,
    forbidden: ADMIN_ONLY,
    errors: {
      422: SAVE_ERRORS,
      503:
        '`DEPENDENCY_UNAVAILABLE`: Telegram did not answer `getMe` for a new token of the ' +
        "organization's notification bot",
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/secrets/{secretId}',
    operationId: 'deleteSecret',
    tag: 'secrets',
    summary: 'Delete a secret no automation uses',
    description: 'Organization owner/admin only. Audited as `secret.deleted`.',
    params: secretParams,
    status: 204,
    forbidden: ADMIN_ONLY,
    errors: {
      409:
        '`SECRET_IN_USE`: automations (deleted ones excepted) use it, or it is the ' +
        "organization's notification bot (T549); `errors[0].params` = " +
        '`{ usages: [{ kind: "notification_channel" } | { kind: "automation", automation_id, ' +
        'base_id, name | null }], total }`',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/secrets/{secretId}/usages',
    operationId: 'listSecretUsages',
    tag: 'secrets',
    summary: 'What uses a secret (automations, notification bot)',
    description:
      'Organization owner/admin only. `{ kind: "notification_channel" }` first when the secret ' +
      "is the organization's notification bot (T549); then the automations — the name is " +
      '`null` when the caller cannot see it.',
    params: secretParams,
    status: 200,
    response: secretUsagesSchema,
    forbidden: ADMIN_ONLY,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/secrets',
    operationId: 'listBaseSecrets',
    tag: 'secrets',
    summary: 'Secrets an automation of the base may use',
    description:
      'Automation managers of the base (base admin or `manage` on a table). Only secrets whose ' +
      'scope includes the base; only `id`, `kind`, `name`.',
    params: baseParams,
    query: baseSecretListQuerySchema,
    status: 200,
    response: baseSecretListSchema,
    forbidden: '`PERMISSION_DENIED`: the caller reads the base but cannot manage automations',
  });
};
