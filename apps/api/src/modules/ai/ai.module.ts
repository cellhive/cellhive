import { Module } from '@nestjs/common';

import { AiAccess } from './ai-access.js';
import { AiFormulaController } from './ai-formula.controller.js';
import { AiFormulaService } from './ai-formula.service.js';
import { AiSettingsController } from './ai-settings.controller.js';
import { AiSettingsService } from './ai-settings.service.js';

/**
 * AI of an organization (S8, ADR-39): settings, quota and usage (T906);
 * `AiAccess` is the door every AI route goes through; the formula (T907) and
 * the next feature routes (T908–T909) add their controllers here.
 */
@Module({
  controllers: [AiSettingsController, AiFormulaController],
  providers: [AiAccess, AiSettingsService, AiFormulaService],
  exports: [AiAccess],
})
export class AiModule {}
