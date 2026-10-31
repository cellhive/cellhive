import { registerAiRoutes } from './routes/ai.js';
import { registerApiTokenRoutes } from './routes/api-tokens.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAutomationRoutes } from './routes/automations.js';
import { registerDashboardRoutes } from './routes/dashboards.js';
import { registerEmailAssetRoutes } from './routes/email-assets.js';
import { registerEmailIdentityRoutes } from './routes/email-identities.js';
import { registerEmailRoutes } from './routes/email.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerFieldConversionRoutes } from './routes/field-conversions.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFormCoverRoutes } from './routes/form-covers.js';
import { registerFormRoutes } from './routes/forms.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHttpAllowlistRoutes } from './routes/http-allowlist.js';
import { registerImportRoutes } from './routes/imports.js';
import { registerIncomingWebhookRoutes } from './routes/incoming-webhooks.js';
import { registerLinkRoutes } from './routes/links.js';
import { registerMemberAccessRoutes } from './routes/member-access.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerOidcRoutes } from './routes/oidc.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerRecordFollowRoutes } from './routes/record-follows.js';
import { registerRecordRoutes } from './routes/records.js';
import { registerRoleRoutes } from './routes/roles.js';
import { registerSecretRoutes } from './routes/secrets.js';
import { registerShareLinkRoutes } from './routes/share-links.js';
import { registerShareRoutes } from './routes/shares.js';
import { registerTableRoutes } from './routes/tables.js';
import { registerUserChannelRoutes } from './routes/user-channels.js';
import { registerViewRoutes } from './routes/views.js';

import type { RouteRegistrar } from './types.js';

/** Every route group in the public document, in registration order. */
export const routeRegistrars: readonly RouteRegistrar[] = [
  registerHealthRoutes,
  registerAuthRoutes,
  registerOidcRoutes,
  registerOrgRoutes,
  registerEmailRoutes,
  registerNotificationRoutes,
  registerUserChannelRoutes,
  registerEmailIdentityRoutes,
  registerSecretRoutes,
  registerHttpAllowlistRoutes,
  registerAiRoutes,
  registerIncomingWebhookRoutes,
  registerApiTokenRoutes,
  registerEmailAssetRoutes,
  registerRecordRoutes,
  registerRecordFollowRoutes,
  registerTableRoutes,
  registerFieldConversionRoutes,
  registerViewRoutes,
  registerRoleRoutes,
  registerMemberAccessRoutes,
  registerExportRoutes,
  registerShareLinkRoutes,
  registerShareRoutes,
  registerFormRoutes,
  registerFormCoverRoutes,
  registerAuditRoutes,
  registerImportRoutes,
  registerFileRoutes,
  registerLinkRoutes,
  registerAutomationRoutes,
  registerDashboardRoutes,
];
