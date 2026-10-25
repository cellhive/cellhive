import { describe, expect, it } from 'vitest';

import {
  API_TOKEN_ROUTE_SCOPES,
  apiTokenRouteIndex,
  apiTokenRouteKey,
  type ApiTokenRouteEntry,
} from '../src/api-token-scopes.js';
import { API_TOKEN_SCOPES } from '../src/api-tokens.js';
import { generateOpenApiDocument } from '../src/openapi/index.js';

describe('API token route → scope table (CONTRACTS §26.3, T704)', () => {
  it.each([
    ['GET', '/api/v1/tables/{tableId}', 'GET /api/v1/tables/{}'],
    ['get', '/api/v1/tables/:tableId', 'GET /api/v1/tables/{}'],
    ['PATCH', '/api/v1/tables/{tableId}/records/{recordId}', 'PATCH /api/v1/tables/{}/records/{}'],
    ['DELETE', '/api/v1/api-tokens/:id', 'DELETE /api/v1/api-tokens/{}'],
    ['GET', '/healthz', 'GET /healthz'],
    ['POST', '/api/v1/tables/{tableId}/records/query', 'POST /api/v1/tables/{}/records/query'],
  ])('keys %s %s as %s', (method, path, key) => {
    expect(apiTokenRouteKey(method, path)).toBe(key);
  });

  it('uses only known scopes and has one entry per route', () => {
    const allowed: readonly string[] = ['session', 'public', ...API_TOKEN_SCOPES];
    const entries: [string, ApiTokenRouteEntry][] = Object.entries(API_TOKEN_ROUTE_SCOPES);
    for (const [operationId, entry] of entries) {
      expect(allowed, operationId).toContain(entry.scope);
      expect(entry.path.startsWith('/api/v1/') || entry.path.startsWith('/'), operationId).toBe(
        true,
      );
    }
    expect(apiTokenRouteIndex().size).toBe(entries.length);
    expect(apiTokenRouteIndex().get('PATCH /api/v1/tables/{}/records/{}')).toMatchObject({
      operationId: 'updateRecord',
      scope: 'records:write',
    });
  });

  it('publishes the scope of every operation in the OpenAPI document', () => {
    const document = generateOpenApiDocument();
    expect(document.components?.securitySchemes).toHaveProperty('apiToken');
    const updateRecord = document.paths?.['/api/v1/tables/{tableId}/records/{recordId}']?.patch;
    expect(updateRecord?.security).toEqual([
      { sessionCookie: [] },
      { apiToken: ['records:write'] },
    ]);
    expect((updateRecord as Record<string, unknown> | undefined)?.['x-api-token-scope']).toBe(
      'records:write',
    );
    const createRole = document.paths?.['/api/v1/bases/{baseId}/roles']?.post;
    expect(createRole?.security).toEqual([{ sessionCookie: [] }]);
    expect((createRole as Record<string, unknown> | undefined)?.['x-api-token-scope']).toBe(
      'session',
    );
  });
});
