import { Module } from '@nestjs/common';

import { OidcClient } from '../../common/auth/oidc/oidc-client.js';
import { OidcStateCookie } from '../../common/auth/oidc/state-cookie.js';
import { MetricsModule } from '../metrics/metrics.module.js';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottle } from './login-throttle.js';
import { MeIdentitiesController } from './me-identities.controller.js';
import { MeIdentitiesService } from './me-identities.service.js';
import { MemberPasswordResetController } from './member-password-reset.controller.js';
import { OidcController } from './oidc.controller.js';
import { OidcLoginService } from './oidc.service.js';
import { PasswordResetService } from './password-reset.service.js';

@Module({
  imports: [MetricsModule],
  controllers: [
    AuthController,
    MemberPasswordResetController,
    OidcController,
    MeIdentitiesController,
  ],
  providers: [
    AuthService,
    LoginThrottle,
    PasswordResetService,
    OidcClient,
    OidcStateCookie,
    OidcLoginService,
    MeIdentitiesService,
  ],
})
export class AuthModule {}
