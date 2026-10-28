import {
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  passwordResetRequestSchema,
  updateMeRequestSchema,
  type ChangePasswordRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type MeResponse,
  type PasswordResetRequest,
  type UpdateMeRequest,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';

import {
  CurrentPrincipal,
  OptionalSessionPrincipal,
  Public,
  sessionOf,
  type Principal,
  type SessionPrincipal,
} from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { SessionService } from '../../common/auth/session.service.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AuthService } from './auth.service.js';
import { PasswordResetService } from './password-reset.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Sign-in/out, `GET|PATCH /me`, `POST /me/password` and the public password
 * reset endpoints (SPEC §13.1).
 */
@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PasswordResetService) private readonly passwordReset: PasswordResetService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Post('auth/login')
  @Public()
  @HttpCode(204)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @OptionalSessionPrincipal() previous: SessionPrincipal | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const { session, token } = await this.auth.login(body, requestMetaOf(request), previous);
    this.sessions.setCookies(reply, request, token, session.id);
  }

  @Post('auth/logout')
  @Public()
  @HttpCode(204)
  async logout(
    @OptionalSessionPrincipal() principal: SessionPrincipal | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (principal !== undefined) await this.auth.logout(principal, requestMetaOf(request));
    this.sessions.clearCookies(reply, request);
  }

  @Get('me')
  me(
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    // The SPA reads the CSRF token from its cookie; bring it back if lost.
    if (
      principal.kind === 'session' &&
      !this.sessions.hasCsrfCookie(request, principal.session.id)
    ) {
      this.sessions.setCsrfCookie(reply, request, principal.session.id);
    }
    return this.auth.me(principal);
  }

  /** Session only (`api-token-scopes.ts`). */
  @Patch('me')
  updateMe(
    @Body(new ZodValidationPipe(updateMeRequestSchema)) body: UpdateMeRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<MeResponse> {
    return this.auth.updateProfile(sessionOf(principal), body, requestMetaOf(request));
  }

  /** Session only (`api-token-scopes.ts`); never logs or audits a password. */
  @Post('me/password')
  @HttpCode(204)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.auth.changePassword(sessionOf(principal), body, requestMetaOf(request));
  }

  @Post('auth/forgot-password')
  @Public()
  @HttpCode(202)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordRequestSchema)) body: ForgotPasswordRequest,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.passwordReset.forgot(body.email, requestMetaOf(request));
  }

  @Post('auth/password-reset/:token')
  @Public()
  @HttpCode(204)
  async resetPassword(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(passwordResetRequestSchema)) body: PasswordResetRequest,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.passwordReset.redeem(
      token,
      { password: body.password, revokeTokens: body.revoke_tokens },
      requestMetaOf(request),
    );
  }
}
