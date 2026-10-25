import { Module } from '@nestjs/common';

import { LocalStorageController } from './local-storage.controller.js';
import { LocalStorageService } from './local-storage.service.js';

@Module({
  controllers: [LocalStorageController],
  providers: [LocalStorageService],
})
export class StorageModule {}
