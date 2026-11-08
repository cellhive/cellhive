import { Module } from '@nestjs/common';

import { BaseExportService } from './base-export.service.js';
import { BasePackageController } from './base-package.controller.js';

/** Whole-base packages (`.chbase`, ADR-24, CONTRACTS §12.2): export (T1017). */
@Module({
  controllers: [BasePackageController],
  providers: [BaseExportService],
  exports: [BaseExportService],
})
export class BasePackageModule {}
