import { Module } from '@nestjs/common';

import { RecordModule } from '../record/record.module.js';

import { FileController } from './file.controller.js';
import { FileService } from './file.service.js';

/** Attachment uploads and downloads (SPEC §16, CONTRACTS §20; BACKLOG T406). */
@Module({
  imports: [RecordModule],
  controllers: [FileController],
  providers: [FileService],
  exports: [FileService],
})
export class FileModule {}
