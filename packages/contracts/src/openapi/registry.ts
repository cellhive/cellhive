import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { API_TOKEN_ROUTE_SCOPES, type ApiTokenRouteEntry } from '../api-token-scopes.js';
import { n8nWorkflowPayloadSchema } from '../automation-actions/run-n8n-workflow.js';
import { formulaFieldOptionsSchema, lookupFieldOptionsSchema } from '../computed-fields.js';
import { dateReminderOptionSchema } from '../date-reminders.js';
import { problemDetailsSchema } from '../errors.js';
import { linkFieldOptionsSchema } from '../links.js';
import { parentFieldOptionsSchema } from '../record-tree.js';

import { API_TOKEN_SECURITY_SCHEME } from './routes/auth.js';
import { routeRegistrars } from './routes.js';

import type { CommonComponents, RouteRegistrar } from './types.js';
import type { ZodType } from 'zod';

export const OPENAPI_INFO = {
  title: 'Cellhive API',
  version: '1.0.0',
  description:
    'Self-hosted, fully open source no-code database platform. Formats follow docs/CONTRACTS.md.',
  license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
} as const;

/**
 * Component schemas carry their name through zod `.meta({ id })`, which the
 * generator turns into `components/schemas/<id>` plus `$ref`s. This avoids
 * `extendZodWithOpenApi`, which would have to patch zod before any schema is
 * created and so add an import-time side effect to the core modules.
 */
const COMMON_COMPONENTS: CommonComponents = { problemDetails: problemDetailsSchema };

/**
 * Component schemas no route names: `FieldOptions` is a generic object (the
 * server validates it per field type), so the options of these types are
 * published as their own components (T471, CONTRACTS §13). `N8nWorkflowPayload`
 * is the body Cellhive sends (`run_n8n_workflow`, T607, CONTRACTS §21), not a route.
 */
export const STANDALONE_SCHEMAS: readonly ZodType[] = [
  linkFieldOptionsSchema,
  parentFieldOptionsSchema,
  formulaFieldOptionsSchema,
  lookupFieldOptionsSchema,
  dateReminderOptionSchema,
  n8nWorkflowPayloadSchema,
];

/** Builds a fresh registry with every registered route. */
export function buildRegistry(
  registrars: readonly RouteRegistrar[] = routeRegistrars,
): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  for (const register of registrars) register(registry, COMMON_COMPONENTS);
  return registry;
}

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

/** Generates the OpenAPI 3.1 document object. */
export function generateOpenApiDocument(
  registrars: readonly RouteRegistrar[] = routeRegistrars,
): OpenApiDocument {
  const generator = new OpenApiGeneratorV31([
    ...buildRegistry(registrars).definitions,
    ...STANDALONE_SCHEMAS.map((schema) => ({ type: 'schema' as const, schema })),
  ]);
  const document = generator.generateDocument({
    openapi: '3.1.0',
    info: { ...OPENAPI_INFO, license: { ...OPENAPI_INFO.license } },
  });
  annotateApiTokenScopes(document);
  return document;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Publishes the route → scope table (CONTRACTS §26.3) on each operation:
 * `x-api-token-scope` (a scope, `session` or `public`), and the `apiToken`
 * security requirement with that scope where a token is accepted. An
 * operation missing from the table gets neither (the lock test fails).
 */
function annotateApiTokenScopes(document: OpenApiDocument): void {
  const table: Readonly<Record<string, ApiTokenRouteEntry>> = API_TOKEN_ROUTE_SCOPES;
  for (const item of Object.values(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      const operationId = operation?.operationId;
      if (operation === undefined || operationId === undefined) continue;
      const entry = Object.hasOwn(table, operationId) ? table[operationId] : undefined;
      if (entry === undefined) continue;
      (operation as Record<string, unknown>)['x-api-token-scope'] = entry.scope;
      if (entry.scope !== 'session' && entry.scope !== 'public') {
        operation.security = [
          ...(operation.security ?? []),
          { [API_TOKEN_SECURITY_SCHEME]: [entry.scope] },
        ];
      }
    }
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic serialization: keys sorted recursively, 2-space indent, trailing newline. */
export function serializeOpenApiDocument(document: unknown): string {
  return `${JSON.stringify(sortKeys(document), null, 2)}\n`;
}
