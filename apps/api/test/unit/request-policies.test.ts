import 'reflect-metadata';

import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { scopeParamOf } from '../../src/common/access/route-scope.service.js';
import {
  IDEMPOTENCY_EXCLUDED_ROUTES,
  idempotencyModeOf,
  routeKeyOf,
} from '../../src/common/idempotency/request-policies.js';
import { RequestPoliciesModule } from '../../src/common/idempotency/request-policies.module.js';

import type { AppConfig } from '@cellhive/server-core';
import type { Logger } from 'pino';

interface Route {
  readonly method: RequestMethod;
  /** Without the `/api/v1` prefix, e.g. `/orgs/:orgId/groups`. */
  readonly path: string;
}

function joinPath(...parts: unknown[]): string {
  const path = parts
    .flatMap((part) => (Array.isArray(part) ? [part[0] as unknown] : [part]))
    .filter((part): part is string => typeof part === 'string' && part !== '' && part !== '/')
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .join('/');
  return `/${path}`;
}

/** Every route of the application, read from the Nest metadata of its controllers. */
function applicationRoutes(): Route[] {
  const dynamic = AppModule.register({
    config: {} as AppConfig,
    rootLogger: {} as Logger,
  });
  const modules = (dynamic.imports ?? []).map((item) =>
    typeof item === 'function' ? item : (item as { module: Type }).module,
  );
  const routes: Route[] = [];
  for (const module of modules) {
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ?? []) as Type[];
    for (const controller of controllers) {
      const prefix: unknown = Reflect.getMetadata(PATH_METADATA, controller);
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        routes.push({
          method,
          path: joinPath(prefix, Reflect.getMetadata(PATH_METADATA, handler)),
        });
      }
    }
  }
  return routes;
}

describe('Idempotency-Key coverage (CONTRACTS §1.1)', () => {
  const routes = applicationRoutes();
  const posts = routes.filter((route) => route.method === RequestMethod.POST);

  it('finds the application routes', () => {
    expect(posts.length).toBeGreaterThan(15);
    expect(posts.map((route) => route.path)).toContain('/tables/:tableId/records');
  });

  it('wraps every POST route except the documented exclusions', () => {
    const unscoped = posts
      .filter((route) => idempotencyModeOf(route.path) === 'unscoped')
      .map((route) => route.path);
    expect(
      unscoped,
      'A POST route names no organization resource: add a scope parameter, or document it ' +
        'in IDEMPOTENCY_EXCLUDED_ROUTES',
    ).toEqual([]);
  });

  it('lists only existing POST routes as exclusions', () => {
    const paths = new Set(posts.map((route) => route.path));
    for (const excluded of Object.keys(IDEMPOTENCY_EXCLUDED_ROUTES)) {
      expect(paths, excluded).toContain(excluded);
    }
  });

  it.each([
    ['/orgs', 'home'],
    ['/orgs/:orgId/workspaces', 'scoped'],
    ['/workspaces/:workspaceId/members', 'scoped'],
    ['/orgs/:orgId/groups', 'scoped'],
    ['/groups/:groupId/members', 'scoped'],
    ['/workspaces/:workspaceId/bases', 'scoped'],
    ['/bases/:baseId/tables', 'scoped'],
    ['/tables/:tableId/fields', 'scoped'],
    ['/bases/:baseId/roles', 'scoped'],
    ['/orgs/:orgId/invitations', 'scoped'],
    ['/orgs/:orgId/members/:userId/password-reset', 'scoped'],
    ['/tables/:tableId/restore', 'scoped'],
    ['/fields/:fieldId/restore', 'scoped'],
    ['/orgs/:orgId/audit-logs/export', 'scoped'],
    ['/tables/:tableId/records', 'scoped'],
    ['/tables/:tableId/views', 'scoped'],
    ['/views/:viewId/duplicate', 'scoped'],
    ['/views/:viewId/share-links', 'scoped'],
    ['/share-links/:shareLinkId/regenerate', 'scoped'],
    ['/bases/:baseId/automations', 'scoped'],
    ['/automations/:automationId/enable', 'scoped'],
    ['/automations/:automationId/take-over', 'scoped'],
    ['/automations/:automationId/duplicate', 'scoped'],
    ['/bases/:baseId/share-links/revoke', 'scoped'],
    ['/orgs/:orgId/share-links/revoke', 'scoped'],
    ['/tables/:tableId/records/query', 'excluded'],
    ['/setup', 'excluded'],
    ['/auth/login', 'excluded'],
    ['/invitations/:token/accept', 'excluded'],
  ] as const)('%s is %s', (path, mode) => {
    expect(posts.map((route) => route.path)).toContain(path);
    expect(idempotencyModeOf(path)).toBe(mode);
  });

  it('scopes a route by its most specific organization parameter', () => {
    expect(scopeParamOf('/orgs/:orgId/groups/:groupId')).toBe('groupId');
    expect(scopeParamOf('/tables/:tableId/records/:recordId/revert')).toBe('tableId');
    expect(scopeParamOf('/fields/:fieldId/restore')).toBe('fieldId');
    expect(scopeParamOf('/share-links/:shareLinkId/regenerate')).toBe('shareLinkId');
    expect(scopeParamOf('/setup')).toBeUndefined();
  });

  it('strips the API prefix from route patterns', () => {
    expect(routeKeyOf('/api/v1/orgs/:orgId')).toBe('/orgs/:orgId');
    expect(routeKeyOf('/healthz')).toBeUndefined();
    expect(routeKeyOf(undefined)).toBeUndefined();
  });

  it('is applied to every route by a global interceptor', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, RequestPoliciesModule) ??
      []) as { provide?: unknown }[];
    expect(providers.some((provider) => provider.provide === APP_INTERCEPTOR)).toBe(true);
  });
});
