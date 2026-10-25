import { Module } from '@nestjs/common';

import { DB } from '../../common/tokens.js';

import { MemberAccessController } from './member-access.controller.js';
import { MemberAccessRepository } from './member-access.repository.js';
import { MemberAccessService } from './member-access.service.js';
import { RoleController } from './role.controller.js';
import { RoleService } from './role.service.js';

import type { Db } from '@cellhive/server-core';

@Module({
  controllers: [RoleController, MemberAccessController],
  providers: [
    RoleService,
    MemberAccessService,
    {
      provide: MemberAccessRepository,
      inject: [DB],
      useFactory: (db: Db) => new MemberAccessRepository(db),
    },
  ],
})
export class RoleModule {}
