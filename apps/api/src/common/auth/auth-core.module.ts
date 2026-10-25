import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RateLimiter } from '../rate-limit/rate-limiter.js';

import { ApiTokenAuthService } from './api-token-auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { PasswordHasher } from './password/password-hasher.js';
import { ScopeGuard } from './scope.guard.js';
import { SessionService } from './session.service.js';

/**
 * Authentication for every route: the global `AuthGuard` (deny by default,
 * CSRF, cookie session or API token) followed by `ScopeGuard` (what an API
 * token may do on the route), `SessionService`, `ApiTokenAuthService`, the
 * Valkey `RateLimiter` and the argon2id `PasswordHasher`. The two guards are
 * registered in this order, so Nest runs them in this order.
 */
@Global()
@Module({
  providers: [
    SessionService,
    ApiTokenAuthService,
    RateLimiter,
    { provide: PasswordHasher, useFactory: () => new PasswordHasher() },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ScopeGuard },
  ],
  exports: [SessionService, ApiTokenAuthService, RateLimiter, PasswordHasher],
})
export class AuthCoreModule {}
