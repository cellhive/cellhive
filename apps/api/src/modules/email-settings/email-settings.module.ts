import { SystemSenderUsageRepository, type Db } from '@cellhive/server-core';
import { Module } from '@nestjs/common';

import { DB } from '../../common/tokens.js';

import { OrgEmailAssetController } from './email-asset.controller.js';
import { EmailAssetService } from './email-asset.service.js';
import { EmailSettingsController } from './email-settings.controller.js';
import { EmailSettingsService } from './email-settings.service.js';
import { OrgEmailSettingsService } from './org-email-settings.service.js';

/**
 * Instance SMTP status and connection test (BACKLOG T513), automation
 * email settings of the organization — footer policy, default signature,
 * system sender (T531) — and signature images (T534), CONTRACTS §23.
 */
@Module({
  controllers: [EmailSettingsController, OrgEmailAssetController],
  providers: [
    EmailSettingsService,
    OrgEmailSettingsService,
    EmailAssetService,
    {
      provide: SystemSenderUsageRepository,
      inject: [DB],
      useFactory: (db: Db) => new SystemSenderUsageRepository(db),
    },
  ],
})
export class EmailSettingsModule {}
