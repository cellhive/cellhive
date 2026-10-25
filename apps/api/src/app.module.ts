import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';

import { AccessModule } from './common/access/access.module.js';
import { AuthCoreModule } from './common/auth/auth-core.module.js';
import { RequestPoliciesModule } from './common/idempotency/request-policies.module.js';
import { CoreModule, type CoreModuleOptions } from './common/infra/core.module.js';
import { DataServicesModule } from './common/infra/data-services.module.js';
import { DbModule } from './common/infra/db.module.js';
import { RepositoriesModule } from './common/infra/repositories.module.js';
import { SchemaCoreModule } from './common/schema/schema-core.module.js';
import { ApiTokenModule } from './modules/api-token/api-token.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { AutomationModule } from './modules/automation/automation.module.js';
import { BaseModule } from './modules/base/base.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { EmailIdentityModule } from './modules/email-identity/email-identity.module.js';
import { EmailSettingsModule } from './modules/email-settings/email-settings.module.js';
import { ExportModule } from './modules/export/export.module.js';
import { FieldModule } from './modules/field/field.module.js';
import { FileModule } from './modules/file/file.module.js';
import { FormModule } from './modules/form/form.module.js';
import { GroupModule } from './modules/group/group.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { HttpAllowlistModule } from './modules/http-allowlist/http-allowlist.module.js';
import { HttpDeliveryModule } from './modules/http-delivery/http-delivery.module.js';
import { ImportModule } from './modules/import/import.module.js';
import { IncomingWebhookModule } from './modules/incoming-webhook/incoming-webhook.module.js';
import { InvitationModule } from './modules/invitation/invitation.module.js';
import { JobModule } from './modules/job/job.module.js';
import { MetricsModule } from './modules/metrics/metrics.module.js';
import { NotificationModule } from './modules/notification/notification.module.js';
import { OpenApiModule } from './modules/openapi/openapi.module.js';
import { OrgModule } from './modules/org/org.module.js';
import { RealtimeBusModule } from './modules/realtime/realtime-bus.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RecordModule } from './modules/record/record.module.js';
import { RoleModule } from './modules/role/role.module.js';
import { SecretModule } from './modules/secret/secret.module.js';
import { SetupModule } from './modules/setup/setup.module.js';
import { ShareModule } from './modules/share/share.module.js';
import { ShareLinkModule } from './modules/share-link/share-link.module.js';
import { StorageModule } from './modules/storage/storage.module.js';
import { TableModule } from './modules/table/table.module.js';
import { ViewModule } from './modules/view/view.module.js';
import { WorkspaceModule } from './modules/workspace/workspace.module.js';

export interface AppModuleOptions extends CoreModuleOptions {
  /** Additional modules, e.g. test-only routes. */
  readonly imports?: ModuleMetadata['imports'];
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(options),
        DbModule,
        RepositoriesModule,
        RealtimeBusModule,
        DataServicesModule,
        AuthCoreModule,
        RequestPoliciesModule,
        AccessModule,
        SchemaCoreModule,
        HealthModule,
        MetricsModule,
        OpenApiModule,
        StorageModule,
        SetupModule,
        AuthModule,
        OrgModule,
        EmailSettingsModule,
        NotificationModule,
        EmailIdentityModule,
        SecretModule,
        HttpAllowlistModule,
        HttpDeliveryModule,
        IncomingWebhookModule,
        ApiTokenModule,
        GroupModule,
        WorkspaceModule,
        BaseModule,
        TableModule,
        FieldModule,
        FileModule,
        InvitationModule,
        RoleModule,
        ViewModule,
        DashboardModule,
        ShareLinkModule,
        AutomationModule,
        ShareModule,
        FormModule,
        RecordModule,
        ExportModule,
        AuditModule,
        JobModule,
        ImportModule,
        RealtimeModule,
        ...(options.imports ?? []),
      ],
    };
  }
}
