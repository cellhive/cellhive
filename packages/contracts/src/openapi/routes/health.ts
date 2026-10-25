import { z } from 'zod';

import { problemResponse, type RouteRegistrar } from '../types.js';

export const healthResponseSchema = z
  .object({ status: z.literal('ok') })
  .meta({ id: 'HealthStatus', description: 'Liveness status' });

/** Dependencies checked by `/readyz` (SPEC §19), in report order. */
export const READINESS_DEPENDENCIES = ['database', 'cache', 'storage'] as const;
export type ReadinessDependency = (typeof READINESS_DEPENDENCIES)[number];

/** Detail code in `errors[].code` of a 503 from `/readyz`; `errors[].path` is `checks.<dependency>`. */
export const DEPENDENCY_DOWN = 'DEPENDENCY_DOWN';

export const readinessResponseSchema = z
  .object({
    status: z.literal('ok'),
    checks: z.object({
      database: z.literal('up').meta({ description: 'PostgreSQL answers `SELECT 1`' }),
      cache: z.literal('up').meta({ description: 'Valkey answers `PING`' }),
      storage: z
        .literal('up')
        .meta({ description: 'Object storage bucket (or local directory) is reachable' }),
    }),
  })
  .meta({ id: 'ReadinessStatus', description: 'Readiness status: every dependency is up' });

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

/** Liveness and readiness probes (SPEC §19). Not under `/api/v1`, unauthenticated. */
export const registerHealthRoutes: RouteRegistrar = (registry, components) => {
  registry.registerPath({
    method: 'get',
    path: '/healthz',
    operationId: 'getHealthz',
    tags: ['system'],
    summary: 'Liveness probe',
    description: 'Answers 200 while the process is running; checks no dependency.',
    security: [],
    responses: {
      200: {
        description: 'The process is up',
        content: { 'application/json': { schema: healthResponseSchema } },
      },
      500: problemResponse(components, 'Unexpected error'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/readyz',
    operationId: 'getReadyz',
    tags: ['system'],
    summary: 'Readiness probe',
    description:
      'Checks PostgreSQL, Valkey and object storage. On failure answers 503 ' +
      '`DEPENDENCY_UNAVAILABLE` with one `errors[]` entry per unavailable dependency ' +
      '(`path` = `checks.<dependency>`, `code` = `DEPENDENCY_DOWN`).',
    security: [],
    responses: {
      200: {
        description: 'Every dependency is up',
        content: { 'application/json': { schema: readinessResponseSchema } },
      },
      500: problemResponse(components, 'Unexpected error'),
      503: problemResponse(components, 'At least one dependency is unavailable'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/openapi.json',
    operationId: 'getOpenApiDocument',
    tags: ['system'],
    summary: 'This OpenAPI 3.1 document',
    description:
      'Generated from the zod contracts (`packages/contracts`); public, no session needed.',
    security: [],
    responses: {
      200: {
        description: 'The OpenAPI document',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    },
  });
};
