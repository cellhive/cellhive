import { Module } from '@nestjs/common';

import { ImportController } from './import.controller.js';
import { ImportService } from './import.service.js';

/** CSV/XLSX import (SPEC §17, CONTRACTS §19; BACKLOG T308). */
@Module({
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
