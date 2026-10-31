import { Module } from '@nestjs/common';

import { AiAccess } from './ai-access.js';
import { AiSettingsController } from './ai-settings.controller.js';
import { AiSettingsService } from './ai-settings.service.js';

/**
 * AI of an organization (S8, ADR-39): settings, quota and usage (T906);
 * `AiAccess` is the door every AI route goes through (T907–T909 add their
 * controllers here).
 */
@Module({
  controllers: [AiSettingsController],
  providers: [AiAccess, AiSettingsService],
  exports: [AiAccess],
})
export class AiModule {}
