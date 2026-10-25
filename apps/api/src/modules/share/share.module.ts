import { type AppConfig } from '@cellhive/server-core';
import { Module } from '@nestjs/common';

import { ShareRateLimits } from '../../common/rate-limit/share-rate-limits.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { ExportModule } from '../export/export.module.js';
import { FileModule } from '../file/file.module.js';
import { ShareLinkModule } from '../share-link/share-link.module.js';

import { ShareAccessStats } from './share-access-stats.js';
import { ShareAccessService } from './share-access.service.js';
import { ShareDashboardController } from './share-dashboard.controller.js';
import { ShareDashboardService } from './share-dashboard.service.js';
import { ShareExportService } from './share-export.service.js';
import { ShareFileController } from './share-file.controller.js';
import { ShareFileService } from './share-file.service.js';
import { SharePageController } from './share-page.controller.js';
import { SharePageService } from './share-page.service.js';
import { ShareUnlockCookies } from './share-unlock-cookies.js';
import { ShareUnlockThrottle } from './share-unlock-throttle.js';
import { ShareController } from './share.controller.js';
import { ShareService } from './share.service.js';

/**
 * Public read-only share endpoints (SPEC §15A.2–15A.4, CONTRACTS §16A;
 * BACKLOG T305). Exports `ShareAccessService` (token, audience, password,
 * per-IP limit) for the form submission of T306. Dashboard links (T809):
 * `/shares/:token/dashboard|widgets/*`, and `/shares/:token/page` (headers
 * of an embedded page).
 */
@Module({
  imports: [ShareLinkModule, FileModule, ExportModule, DashboardModule],
  controllers: [
    ShareController,
    ShareFileController,
    ShareDashboardController,
    SharePageController,
  ],
  providers: [
    ShareService,
    ShareFileService,
    ShareDashboardService,
    SharePageService,
    ShareExportService,
    ShareAccessService,
    ShareAccessStats,
    ShareRateLimits,
    ShareUnlockThrottle,
    {
      provide: ShareUnlockCookies,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new ShareUnlockCookies(config.security.sessionSecret),
    },
  ],
  exports: [ShareAccessService, ShareAccessStats, ShareRateLimits, ShareUnlockCookies],
})
export class ShareModule {}
