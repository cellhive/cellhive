import { Module } from '@nestjs/common';

import { RecordModule } from '../record/record.module.js';

import { ExportLeases } from './export-leases.js';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';

/** Table export as CSV/XLSX (SPEC §17, CONTRACTS §18; BACKLOG T307). */
@Module({
  imports: [RecordModule],
  controllers: [ExportController],
  providers: [ExportService, ExportLeases],
  // Exports through share links (T810) share the slots.
  exports: [ExportLeases],
})
export class ExportModule {}
