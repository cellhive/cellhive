import { Module } from '@nestjs/common';

import { AutomationModule } from '../automation/automation.module.js';

import { AiAccess } from './ai-access.js';
import { AiAutomationController } from './ai-automation.controller.js';
import { AiAutomationService } from './ai-automation.service.js';
import { AiFormulaController } from './ai-formula.controller.js';
import { AiFormulaService } from './ai-formula.service.js';
import { AiSettingsController } from './ai-settings.controller.js';
import { AiSettingsService } from './ai-settings.service.js';

/**
 * AI of an organization (S8, ADR-39): settings, quota and usage (T906);
 * `AiAccess` is the door every AI route goes through; the formula (T907),
 * the automation draft (T908, checked by `AutomationService` like a save)
 * and the next feature routes (T909) add their controllers here.
 */
@Module({
  imports: [AutomationModule],
  controllers: [AiSettingsController, AiFormulaController, AiAutomationController],
  providers: [AiAccess, AiSettingsService, AiFormulaService, AiAutomationService],
  exports: [AiAccess],
})
export class AiModule {}
