import { AppError, isAppError, type AppConfig } from '@cellhive/server-core';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';

import { AccessService } from '../../common/access/access.service.js';
import { RouteScopeService } from '../../common/access/route-scope.service.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { ApiRateLimits } from '../../common/rate-limit/api-rate-limits.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { BaseService } from '../base/base.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';

import { mcpPolicyOf } from './mcp-policy.js';
import { McpEndpoint } from './mcp-server.js';
import { mcpTools } from './tools/index.js';

import type { Principal } from '../../common/auth/principal.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** JSON-RPC methods named in `mcp_requests_total`; anything else is `other` (bounded labels). */
const METHOD_LABELS: ReadonlySet<string> = new Set([
  'server/discover',
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call',
  'ping',
]);

function methodLabelOf(body: unknown): string {
  const method = (body as { method?: unknown } | null)?.method;
  return typeof method === 'string' && METHOD_LABELS.has(method) ? method : 'other';
}

/** Headers the SDK never sees: the credentials stay in the API's own guards. */
const HIDDEN_HEADERS: ReadonlySet<string> = new Set(['authorization', 'cookie']);

function webRequestOf(request: FastifyRequest, base: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (HIDDEN_HEADERS.has(name) || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return new Request(new URL(request.url, base), { method: request.method, headers });
}

/**
 * `POST /api/v1/mcp` (CONTRACTS §30.1, ADR-40, BACKLOG T920). `AuthGuard`
 * (`@BearerOnly`), `ScopeGuard` (`schema:read`) and the per-token rate limit
 * already ran; then, before any JSON-RPC:
 * - an `Origin` header other than the origin of `PUBLIC_URL` → `403`
 *   (DNS rebinding, required by the MCP transport spec);
 * - `settings.mcp.enabled` off → `403 MCP_DISABLED`.
 * The tools are registered here, in `tools/list` order; each declares its
 * scope (`tool-context.ts`).
 */
@Injectable()
export class McpService implements OnApplicationShutdown {
  private readonly endpoint: McpEndpoint;
  private readonly origin: string;
  private readonly requests: Counter<'method' | 'status'>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(RouteScopeService) scopes: RouteScopeService,
    @Inject(ApiRateLimits) limits: ApiRateLimits,
    @Inject(WorkspaceService) workspaces: WorkspaceService,
    @Inject(BaseService) bases: BaseService,
    @Inject(MetricsService) metrics: MetricsService,
    @Inject(AppLogger) logger: AppLogger,
  ) {
    this.origin = new URL(config.publicUrl).origin;
    this.requests = new Counter({
      name: 'mcp_requests_total',
      help: 'Requests to POST /api/v1/mcp that reached the MCP handler, by JSON-RPC method and HTTP status',
      labelNames: ['method', 'status'],
      registers: [metrics.registry],
    });
    const calls = new Counter({
      name: 'mcp_tool_calls_total',
      help: 'MCP tool calls, by tool and outcome (error = a result with isError)',
      labelNames: ['tool', 'status'],
      registers: [metrics.registry],
    });
    const duration = new Histogram({
      name: 'mcp_tool_seconds',
      help: 'Duration of MCP tool calls, by tool',
      labelNames: ['tool'],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [metrics.registry],
    });
    this.endpoint = new McpEndpoint(mcpTools({ workspaces, bases }), {
      resolve: (principal, params) => scopes.resolve(principal, params),
      hitBase: (principalKey, baseId) => limits.hitBase(principalKey, baseId),
      observe: (tool, status, seconds) => {
        calls.inc({ tool, status });
        duration.observe({ tool }, seconds);
      },
      onUnexpected: (tool, error) => {
        logger.error({ err: error, tool }, 'mcp tool call failed');
      },
    });
  }

  async handle(principal: Principal, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const method = methodLabelOf(request.body);
    try {
      const response = await this.serve(principal, request);
      this.requests.inc({ method, status: String(response.status) });
      void reply.status(response.status);
      response.headers.forEach((value, name) => {
        void reply.header(name, value);
      });
      const body = await response.text();
      await reply.send(body === '' ? undefined : body);
    } catch (error) {
      this.requests.inc({ method, status: String(isAppError(error) ? error.status : 500) });
      throw error;
    }
  }

  private async serve(principal: Principal, request: FastifyRequest): Promise<Response> {
    // `@BearerOnly()`: only API tokens get here.
    if (principal.kind !== 'api_token') throw new AppError('UNAUTHENTICATED');
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.origin) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'The Origin of the request is not this server.',
      });
    }
    const org = await this.access.requireOrg(principal, principal.organizationId);
    const policy = mcpPolicyOf(org.membership.settings);
    if (!policy.enabled) {
      throw new AppError('MCP_DISABLED', {
        detail: 'MCP is turned off for this organization (settings.mcp.enabled).',
      });
    }
    return this.endpoint.handle(webRequestOf(request, this.config.publicUrl), request.body, {
      principal,
      policy,
    });
  }

  onApplicationShutdown(): Promise<void> {
    return this.endpoint.close();
  }
}
