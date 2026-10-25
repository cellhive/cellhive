import 'reflect-metadata';

import { readFile } from 'node:fs/promises';

import {
  API_TOKEN_ROUTE_SCOPES,
  API_TOKEN_SCOPES,
  apiTokenRouteKey,
  type ApiTokenRouteEntry,
} from '@cellhive/contracts';
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { API_PREFIX, ROOT_ROUTES } from '../../src/app.factory.js';
import { AppModule } from '../../src/app.module.js';
import { PUBLIC_ACCESS } from '../../src/common/auth/principal.js';
import { apiTokenRouteScopeOf } from '../../src/common/auth/scope.guard.js';

import type { AppConfig } from '@cellhive/server-core';
import type { Logger } from 'pino';

/** One operation of the OpenAPI document. */
interface Operation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly tokenScope: unknown;
}

/** One route of the Nest application. */
interface ControllerRoute {
  readonly method: string;
  /** Full path, e.g. `/api/v1/tables/:tableId`. */
  readonly path: string;
  readonly isPublic: boolean;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

function operationsOf(document: {
  paths: Record<string, Record<string, { operationId?: string; 'x-api-token-scope'?: unknown }>>;
}): Operation[] {
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (operation?.operationId === undefined) continue;
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        tokenScope: operation['x-api-token-scope'],
      });
    }
  }
  return operations;
}

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

function joinPath(...parts: unknown[]): string {
  return `/${parts
    .flatMap((part) => (Array.isArray(part) ? [part[0] as unknown] : [part]))
    .filter((part): part is string => typeof part === 'string' && part !== '' && part !== '/')
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .join('/')}`;
}

/** Every module reachable from `AppModule`, nested imports included. */
function modulesOf(root: unknown, seen = new Set<Type>()): Type[] {
  const queue: unknown[] = [root];
  const found: Type[] = [];
  while (queue.length > 0) {
    let item = queue.shift();
    if (item !== null && typeof item === 'object' && 'forwardRef' in item) {
      item = (item as { forwardRef: () => unknown }).forwardRef();
    }
    let type: Type | undefined;
    const extra: unknown[] = [];
    if (typeof item === 'function') type = item as Type;
    else if (item !== null && typeof item === 'object' && 'module' in item) {
      const dynamic = item as { module: Type; imports?: unknown[]; controllers?: Type[] };
      type = dynamic.module;
      extra.push(...(dynamic.imports ?? []));
      if (dynamic.controllers !== undefined) {
        Reflect.defineMetadata(
          'app:test:dynamicControllers',
          [
            ...((Reflect.getMetadata('app:test:dynamicControllers', type) ?? []) as Type[]),
            ...dynamic.controllers,
          ],
          type,
        );
      }
    }
    queue.push(...extra);
    if (type === undefined || seen.has(type)) continue;
    seen.add(type);
    found.push(type);
    queue.push(...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, type) ?? []) as unknown[]));
  }
  return found;
}

/** Every route of the application, read from the Nest metadata of its controllers. */
function controllerRoutes(): ControllerRoute[] {
  const dynamic = AppModule.register({ config: {} as AppConfig, rootLogger: {} as Logger });
  const routes: ControllerRoute[] = [];
  const controllers = new Set<Type>();
  for (const module of modulesOf(dynamic)) {
    for (const controller of [
      ...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ?? []) as Type[]),
      ...((Reflect.getMetadata('app:test:dynamicControllers', module) ?? []) as Type[]),
    ]) {
      controllers.add(controller);
    }
  }
  for (const controller of controllers) {
    const prefix: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const classPublic = Reflect.getMetadata(PUBLIC_ACCESS, controller) !== undefined;
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const local = joinPath(prefix, Reflect.getMetadata(PATH_METADATA, handler));
      const root = ROOT_ROUTES.some((route) => local === `/${route}`);
      routes.push({
        method: METHOD_NAMES[method] ?? String(method),
        path: root ? local : `/${API_PREFIX}${local === '/' ? '' : local}`,
        isPublic: classPublic || Reflect.getMetadata(PUBLIC_ACCESS, handler) !== undefined,
      });
    }
  }
  return routes;
}

/**
 * The lock of CONTRACTS §26.3: what is wrong between the OpenAPI document,
 * the route → scope table and the controllers. Empty = consistent.
 */
function routeScopeProblems(
  operations: readonly Operation[],
  table: Readonly<Record<string, ApiTokenRouteEntry>>,
  routes: readonly ControllerRoute[],
): string[] {
  const problems: string[] = [];
  const byId = new Map<string, Operation>();
  for (const operation of operations) {
    if (byId.has(operation.operationId)) {
      problems.push(`duplicate operationId ${operation.operationId}`);
    }
    byId.set(operation.operationId, operation);
    const entry = Object.hasOwn(table, operation.operationId)
      ? table[operation.operationId]
      : undefined;
    if (entry === undefined) {
      problems.push(
        `${operation.operationId} (${operation.method} ${operation.path}) has no entry in ` +
          'API_TOKEN_ROUTE_SCOPES',
      );
      continue;
    }
    if (entry.method !== operation.method || entry.path !== operation.path) {
      problems.push(
        `${operation.operationId}: entry says ${entry.method} ${entry.path}, OpenAPI says ` +
          `${operation.method} ${operation.path}`,
      );
    }
    if (operation.tokenScope !== entry.scope) {
      problems.push(`${operation.operationId}: openapi.json is stale (run pnpm gen:openapi)`);
    }
  }
  const keys = new Map<string, string>();
  for (const [operationId, entry] of Object.entries(table)) {
    if (!byId.has(operationId)) problems.push(`entry ${operationId} names no OpenAPI operation`);
    if (!['session', 'public', ...API_TOKEN_SCOPES].includes(entry.scope)) {
      problems.push(`entry ${operationId}: unknown scope ${entry.scope}`);
    }
    const key = apiTokenRouteKey(entry.method, entry.path);
    const other = keys.get(key);
    if (other !== undefined) problems.push(`entries ${other} and ${operationId} are one route`);
    keys.set(key, operationId);
  }
  const documented = new Set(operations.map((item) => apiTokenRouteKey(item.method, item.path)));
  const served = new Set(routes.map((route) => apiTokenRouteKey(route.method, route.path)));
  for (const [key, operationId] of keys) {
    if (!served.has(key)) problems.push(`entry ${operationId} names no controller route`);
  }
  for (const route of routes) {
    const key = apiTokenRouteKey(route.method, route.path);
    const operationId = keys.get(key);
    if (operationId === undefined) {
      // Public routes outside the document (metrics, signed storage URLs,
      // the Telegram webhook) ignore `Authorization`.
      if (!route.isPublic || documented.has(key)) {
        problems.push(`route ${route.method} ${route.path} has no entry in API_TOKEN_ROUTE_SCOPES`);
      }
      continue;
    }
    const scope = table[operationId]?.scope;
    if ((scope === 'public') !== route.isPublic) {
      problems.push(
        `${operationId}: scope ${String(scope)} but the route is ` +
          (route.isPublic ? '@Public()' : 'not @Public()'),
      );
    }
  }
  return problems;
}

/**
 * BACKLOG T704 lock test (CONTRACTS §26.3, ADR-36 §1): every operation of
 * `packages/contracts/openapi.json` has exactly one entry in
 * `API_TOKEN_ROUTE_SCOPES` (a scope, `session` or `public`), every entry
 * names an operation with the same method and path, every controller route
 * has an entry, and `public` entries are exactly the `@Public()` routes.
 */
describe('API token route → scope table (T704 lock)', () => {
  const load = async () =>
    operationsOf(
      JSON.parse(
        await readFile(
          new URL('../../../../packages/contracts/openapi.json', import.meta.url),
          'utf8',
        ),
      ) as Parameters<typeof operationsOf>[0],
    );
  const routes = controllerRoutes();

  it('covers every OpenAPI operation and controller route exactly once', async () => {
    const operations = await load();
    expect(operations.length).toBeGreaterThan(200);
    expect(routes.length).toBeGreaterThan(200);
    expect(routeScopeProblems(operations, API_TOKEN_ROUTE_SCOPES, routes)).toEqual([]);
  });

  it('turns red for a route without an entry, a stale entry or a wrong public flag', async () => {
    const operations = await load();
    const fake: Operation = {
      operationId: 'listFakeThings',
      method: 'GET',
      path: '/api/v1/fake-things',
      tokenScope: undefined,
    };
    expect(routeScopeProblems([...operations, fake], API_TOKEN_ROUTE_SCOPES, routes)).toEqual([
      'listFakeThings (GET /api/v1/fake-things) has no entry in API_TOKEN_ROUTE_SCOPES',
    ]);
    const withoutGetRecord: Record<string, ApiTokenRouteEntry> = { ...API_TOKEN_ROUTE_SCOPES };
    delete withoutGetRecord['getRecord'];
    expect(routeScopeProblems(operations, withoutGetRecord, routes)).toEqual([
      'getRecord (GET /api/v1/tables/{tableId}/records/{recordId}) has no entry in ' +
        'API_TOKEN_ROUTE_SCOPES',
      'route GET /api/v1/tables/:tableId/records/:recordId has no entry in API_TOKEN_ROUTE_SCOPES',
    ]);
    expect(
      routeScopeProblems(
        operations,
        {
          ...API_TOKEN_ROUTE_SCOPES,
          listGhosts: { method: 'GET', path: '/api/v1/ghosts', scope: 'records:read' },
        },
        routes,
      ),
    ).toEqual([
      'entry listGhosts names no OpenAPI operation',
      'entry listGhosts names no controller route',
    ]);
    expect(
      routeScopeProblems(
        operations,
        { ...API_TOKEN_ROUTE_SCOPES, login: { ...API_TOKEN_ROUTE_SCOPES.login, scope: 'session' } },
        routes,
      ),
    ).toEqual([
      'login: openapi.json is stale (run pnpm gen:openapi)',
      'login: scope session but the route is @Public()',
    ]);
    const undocumented: ControllerRoute = {
      method: 'POST',
      path: '/api/v1/tables/:tableId/secret-door',
      isPublic: false,
    };
    expect(
      routeScopeProblems(operations, API_TOKEN_ROUTE_SCOPES, [...routes, undocumented]),
    ).toEqual([
      'route POST /api/v1/tables/:tableId/secret-door has no entry in API_TOKEN_ROUTE_SCOPES',
    ]);
  });

  it('looks routes up by their server pattern, HEAD as GET, unknown routes as session only', () => {
    expect(apiTokenRouteScopeOf('PATCH', '/api/v1/tables/:tableId/records/:recordId')).toBe(
      'records:write',
    );
    expect(apiTokenRouteScopeOf('HEAD', '/api/v1/files/:attachmentId')).toBe('records:read');
    expect(apiTokenRouteScopeOf('POST', '/api/v1/bases/:baseId/roles')).toBe('session');
    expect(apiTokenRouteScopeOf('GET', '/api/v1/not-a-route')).toBe('session');
    expect(apiTokenRouteScopeOf('GET', undefined)).toBe('session');
  });

  it('keeps the BACKLOG T704 classes of routes', () => {
    const scopeOf = (id: keyof typeof API_TOKEN_ROUTE_SCOPES) => API_TOKEN_ROUTE_SCOPES[id].scope;
    expect(scopeOf('queryRecords')).toBe('records:read');
    expect(scopeOf('exportTable')).toBe('records:read');
    expect(scopeOf('downloadAttachment')).toBe('records:read');
    expect(scopeOf('getJob')).toBe('records:read');
    expect(scopeOf('listBaseMembers')).toBe('records:read');
    expect(scopeOf('updateRecord')).toBe('records:write');
    expect(scopeOf('createUpload')).toBe('records:write');
    expect(scopeOf('startImport')).toBe('records:write');
    expect(scopeOf('clickButton')).toBe('records:write');
    expect(scopeOf('getMe')).toBe('schema:read');
    expect(scopeOf('listOrganizations')).toBe('schema:read');
    expect(scopeOf('getBase')).toBe('schema:read');
    expect(scopeOf('createField')).toBe('schema:write');
    expect(scopeOf('convertField')).toBe('schema:write');
    expect(scopeOf('getAutomation')).toBe('automations:read');
    expect(scopeOf('rerunAutomationRun')).toBe('automations:write');
    expect(scopeOf('createIncomingWebhook')).toBe('automations:write');
    // The DTO carries the hook URL, which starts runs: reading it is a write capability.
    expect(scopeOf('getIncomingWebhook')).toBe('automations:write');
    expect(scopeOf('listIncomingWebhooks')).toBe('automations:write');
    expect(scopeOf('listIncomingWebhookRequests')).toBe('automations:read');
    for (const id of [
      'createApiToken',
      'createRole',
      'assignRole',
      'listOrgMembers',
      'createGroup',
      'createWorkspace',
      'createInvitation',
      'createSecret',
      'createHttpAllowlistEntry',
      'createShareLink',
      'listOrgAuditLogs',
      'updateOrganization',
      'updateBase',
      'createEmailIdentity',
      'listMyChannels',
      'listMyNotifications',
    ] as const) {
      expect(scopeOf(id), id).toBe('session');
    }
    for (const id of [
      'queryShareRecords',
      'receiveIncomingWebhook',
      'login',
      'startOidcLogin',
      'completeOidcLogin',
      'listAuthProviders',
      'getSetupStatus',
      'getHealthz',
    ] as const) {
      expect(scopeOf(id), id).toBe('public');
    }
  });
});
