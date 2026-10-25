import { Module } from '@nestjs/common';

import { TableController } from './table.controller.js';
import { TableService } from './table.service.js';

@Module({
  controllers: [TableController],
  providers: [TableService],
})
export class TableModule {}
