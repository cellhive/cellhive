import { DashboardsRepository, FieldsRepository, TablesRepository } from '@cellhive/server-core';
import { Global, Module } from '@nestjs/common';

import { AccessService } from './access.service.js';
import { BASE_SCHEMA_META, MetaBaseSchemaLoader } from './base-schema-meta.js';
import { PermissionVersions } from './change-log.js';
import { BaseAccessGuard } from './require-base.js';
import { RouteScopeService } from './route-scope.service.js';

/**
 * Access resolution for every module: `AccessService`, the `@RequireBase`
 * guard, `PermissionVersions` and `RouteScopeService` (the organization and
 * base a route acts on, for request policies). `BASE_SCHEMA_META` reads the
 * tables, fields (T103) and dashboards (T805) of a base from meta.
 */
@Global()
@Module({
  providers: [
    AccessService,
    BaseAccessGuard,
    PermissionVersions,
    RouteScopeService,
    {
      provide: BASE_SCHEMA_META,
      inject: [TablesRepository, FieldsRepository, DashboardsRepository],
      useFactory: (
        tables: TablesRepository,
        fields: FieldsRepository,
        dashboards: DashboardsRepository,
      ) => new MetaBaseSchemaLoader(tables, fields, dashboards),
    },
  ],
  exports: [
    AccessService,
    BaseAccessGuard,
    PermissionVersions,
    RouteScopeService,
    BASE_SCHEMA_META,
  ],
})
export class AccessModule {}
