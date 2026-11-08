import { Module } from '@nestjs/common';

import { ComputedPreviewService } from './computed-preview.service.js';
import { FieldConversionService } from './field-conversion.service.js';
import { FieldDtoService } from './field-dto.service.js';
import { FieldController } from './field.controller.js';
import { FieldService } from './field.service.js';
import { LinkConversionService } from './link-conversion.service.js';

@Module({
  controllers: [FieldController],
  providers: [
    FieldService,
    FieldDtoService,
    FieldConversionService,
    LinkConversionService,
    ComputedPreviewService,
  ],
  exports: [FieldService],
})
export class FieldModule {}
