import {
  AutomationEmailPreviewer,
  HttpRequestTester,
  RecordQueryService,
  type AppConfig,
  type Db,
  type Mailer,
  type StorageDriver,
} from '@cellhive/server-core';
import { transcodeEmailImage } from '@cellhive/worker';
import { Module } from '@nestjs/common';

import { APP_CONFIG, DB, MAIL_SERVICE, STORAGE_DRIVER } from '../../common/tokens.js';
import { EmailAssetService } from '../email-settings/email-asset.service.js';

import { AutomationDuplicateController } from './automation-duplicate.controller.js';
import { AutomationEmailAssetController } from './automation-email-asset.controller.js';
import { AutomationEmailController } from './automation-email.controller.js';
import { AutomationEmailService } from './automation-email.service.js';
import { AutomationHttpTestController } from './automation-http-test.controller.js';
import { AutomationHttpTestService } from './automation-http-test.service.js';
import { AutomationController } from './automation.controller.js';
import { AutomationService } from './automation.service.js';
import { AutomationRunsController } from './runs/automation-runs.controller.js';
import { AutomationRunsService } from './runs/automation-runs.service.js';

/**
 * Automation management: definitions, enable/disable, `run_as` and take
 * over (BACKLOG T502); preview and test email of `send_email` (T514); run
 * history, re-run and cancel (T518); duplicate with body images (T551);
 * "Send a test" of `http_request` through the outbox (T606).
 */
@Module({
  controllers: [
    AutomationController,
    AutomationDuplicateController,
    AutomationEmailController,
    AutomationEmailAssetController,
    AutomationHttpTestController,
    AutomationRunsController,
  ],
  providers: [
    AutomationService,
    AutomationEmailService,
    AutomationHttpTestService,
    AutomationRunsService,
    EmailAssetService,
    {
      provide: AutomationEmailPreviewer,
      inject: [DB, APP_CONFIG, RecordQueryService, MAIL_SERVICE, STORAGE_DRIVER],
      useFactory: (
        db: Db,
        config: AppConfig,
        query: RecordQueryService,
        mailer: Mailer,
        storage: StorageDriver,
      ) =>
        new AutomationEmailPreviewer(db, {
          config,
          query,
          mailer,
          storage,
          transcodeImage: transcodeEmailImage,
        }),
    },
    {
      provide: HttpRequestTester,
      inject: [DB, APP_CONFIG, RecordQueryService],
      useFactory: (db: Db, config: AppConfig, query: RecordQueryService) =>
        new HttpRequestTester(db, {
          masterKey: config.security.appMasterKey,
          query,
          defaults: { timeZone: config.defaults.timezone, locale: config.defaults.locale },
          publicUrl: config.publicUrl,
        }),
    },
  ],
  exports: [AutomationService],
})
export class AutomationModule {}
