import { Controller, Delete, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';

import {
  BearerOnly,
  CurrentPrincipal,
  Public,
  type Principal,
} from '../../common/auth/principal.js';

import { McpService } from './mcp.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/** No SSE stream to open and no session to end: the server is stateless (CONTRACTS §30.1). */
function methodNotAllowed(reply: FastifyReply): void {
  void reply.status(405).header('allow', 'POST').send();
}

/** The MCP server (CONTRACTS §30.1, BACKLOG T920); see `McpService`. */
@Controller('mcp')
export class McpController {
  constructor(@Inject(McpService) private readonly mcp: McpService) {}

  /** The JSON-RPC body is the SDK's to validate (JSON-RPC errors, not `422`). */
  @Post()
  @HttpCode(200)
  @BearerOnly()
  post(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    return this.mcp.handle(principal, request, reply);
  }

  @Get()
  @Public({ ignoreSession: true })
  get(@Res() reply: FastifyReply): void {
    methodNotAllowed(reply);
  }

  @Delete()
  @Public({ ignoreSession: true })
  delete(@Res() reply: FastifyReply): void {
    methodNotAllowed(reply);
  }
}
