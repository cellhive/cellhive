import type { ApiTokenScope } from './api-tokens.js';

/**
 * Route → scope table of API tokens (CONTRACTS §26.3, ADR-36 §1, BACKLOG
 * T704). Every operation of the OpenAPI document has exactly one entry,
 * keyed by its `operationId`; `apps/api/test/int/api-token-scopes.int.test.ts`
 * fails when an operation has no entry, an entry names no operation, an
 * entry's method/path differ from the document, or a controller route has
 * no entry.
 *
 * - an `ApiTokenScope`: a token needs that scope (`*:write` never implies
 *   `*:read`), and its user still needs the access a session would have;
 * - `session`: cookie session only; a token gets `403 INSUFFICIENT_SCOPE`
 *   with `errors[0].params.required = ["session"]` (token management, roles,
 *   members, groups, workspace administration, invitations, secrets,
 *   allowlist, share link management, audit, organization/base settings,
 *   AI settings and usage,
 *   email identities, notification channels, the caller's notifications);
 * - `public`: the route needs no sign-in (`@Public()`) and ignores the
 *   `Authorization` header (shares, incoming webhooks, sign-in, OIDC, setup,
 *   health).
 *
 * A route missing from this table never accepts a token (deny by default).
 * A task that adds a route adds its entry here, in the block of its tag.
 */
export type ApiTokenRouteScope = ApiTokenScope | 'session' | 'public';

export type ApiTokenRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiTokenRouteEntry {
  readonly method: ApiTokenRouteMethod;
  /** OpenAPI path, e.g. `/api/v1/tables/{tableId}/records`. */
  readonly path: string;
  readonly scope: ApiTokenRouteScope;
}

export const API_TOKEN_ROUTE_SCOPES = {
  // ai (S8): settings and usage are organization administration, session only
  // (the formula reads the schema and stores nothing: `schema:read`)
  generateAiFormula: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/ai/formula',
    scope: 'schema:read',
  },
  getAiSettings: { method: 'GET', path: '/api/v1/orgs/{orgId}/ai-settings', scope: 'session' },
  getAiUsage: { method: 'GET', path: '/api/v1/orgs/{orgId}/ai-usage', scope: 'session' },
  testAiSettings: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/ai-settings/test',
    scope: 'session',
  },
  updateAiSettings: { method: 'PUT', path: '/api/v1/orgs/{orgId}/ai-settings', scope: 'session' },
  // api-tokens
  createApiToken: { method: 'POST', path: '/api/v1/orgs/{orgId}/me/api-tokens', scope: 'session' },
  listMyApiTokens: { method: 'GET', path: '/api/v1/orgs/{orgId}/me/api-tokens', scope: 'session' },
  listOrgApiTokens: { method: 'GET', path: '/api/v1/orgs/{orgId}/api-tokens', scope: 'session' },
  revokeApiToken: { method: 'DELETE', path: '/api/v1/api-tokens/{apiTokenId}', scope: 'session' },
  updateApiToken: { method: 'PATCH', path: '/api/v1/api-tokens/{apiTokenId}', scope: 'session' },
  // audit
  exportBaseAuditLogs: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/audit-logs/export',
    scope: 'session',
  },
  exportOrgAuditLogs: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/audit-logs/export',
    scope: 'session',
  },
  listBaseAuditLogs: { method: 'GET', path: '/api/v1/bases/{baseId}/audit-logs', scope: 'session' },
  listOrgAuditLogs: { method: 'GET', path: '/api/v1/orgs/{orgId}/audit-logs', scope: 'session' },
  redactOrgAuditLogs: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/audit-logs/redact',
    scope: 'session',
  },
  // auth
  changeMyPassword: { method: 'POST', path: '/api/v1/me/password', scope: 'session' },
  completeOidcLogin: {
    method: 'GET',
    path: '/api/v1/auth/oidc/{provider}/callback',
    scope: 'public',
  },
  createMemberPasswordResetLink: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/members/{userId}/password-reset',
    scope: 'session',
  },
  deleteMyIdentity: {
    method: 'DELETE',
    path: '/api/v1/me/identities/{userIdentityId}',
    scope: 'session',
  },
  forgotPassword: { method: 'POST', path: '/api/v1/auth/forgot-password', scope: 'public' },
  getMe: { method: 'GET', path: '/api/v1/me', scope: 'schema:read' },
  listAuthProviders: { method: 'GET', path: '/api/v1/auth/providers', scope: 'public' },
  listMyIdentities: { method: 'GET', path: '/api/v1/me/identities', scope: 'session' },
  login: { method: 'POST', path: '/api/v1/auth/login', scope: 'public' },
  logout: { method: 'POST', path: '/api/v1/auth/logout', scope: 'public' },
  resetPassword: { method: 'POST', path: '/api/v1/auth/password-reset/{token}', scope: 'public' },
  startOidcLink: {
    method: 'POST',
    path: '/api/v1/me/identities/{provider}/start',
    scope: 'session',
  },
  startOidcLogin: { method: 'GET', path: '/api/v1/auth/oidc/{provider}/start', scope: 'public' },
  updateMe: { method: 'PATCH', path: '/api/v1/me', scope: 'session' },
  // automations
  cancelAutomationRun: {
    method: 'POST',
    path: '/api/v1/automation-runs/{runId}/cancel',
    scope: 'automations:write',
  },
  clickButton: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/{recordId}/buttons/{fieldId}/click',
    scope: 'records:write',
  },
  completeAutomationEmailAssetUpload: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/email-assets/uploads/{assetId}/complete',
    scope: 'automations:write',
  },
  createAutomation: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/automations',
    scope: 'automations:write',
  },
  createAutomationEmailAssetUpload: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/email-assets/uploads',
    scope: 'automations:write',
  },
  deleteAutomation: {
    method: 'DELETE',
    path: '/api/v1/automations/{automationId}',
    scope: 'automations:write',
  },
  deleteAutomationEmailAsset: {
    method: 'DELETE',
    path: '/api/v1/automations/{automationId}/email-assets/{assetId}',
    scope: 'automations:write',
  },
  disableAutomation: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/disable',
    scope: 'automations:write',
  },
  duplicateAutomation: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/duplicate',
    scope: 'automations:write',
  },
  enableAutomation: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/enable',
    scope: 'automations:write',
  },
  getAutomation: {
    method: 'GET',
    path: '/api/v1/automations/{automationId}',
    scope: 'automations:read',
  },
  getAutomationEmailAsset: {
    method: 'GET',
    path: '/api/v1/automations/{automationId}/email-assets/{assetId}',
    scope: 'automations:read',
  },
  getAutomationRun: {
    method: 'GET',
    path: '/api/v1/automation-runs/{runId}',
    scope: 'automations:read',
  },
  getHttpDelivery: {
    method: 'GET',
    path: '/api/v1/http-deliveries/{deliveryId}',
    scope: 'automations:read',
  },
  listAutomationRuns: {
    method: 'GET',
    path: '/api/v1/automations/{automationId}/runs',
    scope: 'automations:read',
  },
  listAutomations: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/automations',
    scope: 'automations:read',
  },
  listBaseAutomationRuns: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/automation-runs',
    scope: 'automations:read',
  },
  previewAutomationEmail: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/actions/{actionId}/email-preview',
    scope: 'automations:write',
  },
  rerunAutomationRun: {
    method: 'POST',
    path: '/api/v1/automation-runs/{runId}/rerun',
    scope: 'automations:write',
  },
  sendAutomationTestEmail: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/actions/{actionId}/email-test',
    scope: 'automations:write',
  },
  sendAutomationTestHttpRequest: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/actions/{actionId}/http-test',
    scope: 'automations:write',
  },
  takeOverAutomation: {
    method: 'POST',
    path: '/api/v1/automations/{automationId}/take-over',
    scope: 'automations:write',
  },
  updateAutomation: {
    method: 'PATCH',
    path: '/api/v1/automations/{automationId}',
    scope: 'automations:write',
  },
  validateAutomationTemplate: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/automations/validate-template',
    scope: 'automations:write',
  },
  // bases
  createBase: { method: 'POST', path: '/api/v1/workspaces/{workspaceId}/bases', scope: 'session' },
  deleteBase: { method: 'DELETE', path: '/api/v1/bases/{baseId}', scope: 'session' },
  getBase: { method: 'GET', path: '/api/v1/bases/{baseId}', scope: 'schema:read' },
  listBaseMembers: { method: 'GET', path: '/api/v1/bases/{baseId}/members', scope: 'records:read' },
  listBases: {
    method: 'GET',
    path: '/api/v1/workspaces/{workspaceId}/bases',
    scope: 'schema:read',
  },
  restoreBase: { method: 'POST', path: '/api/v1/bases/{baseId}/restore', scope: 'session' },
  updateBase: { method: 'PATCH', path: '/api/v1/bases/{baseId}', scope: 'session' },
  // dashboards
  createDashboard: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/dashboards',
    scope: 'schema:write',
  },
  createWidget: {
    method: 'POST',
    path: '/api/v1/dashboards/{dashboardId}/widgets',
    scope: 'schema:write',
  },
  deleteDashboard: {
    method: 'DELETE',
    path: '/api/v1/dashboards/{dashboardId}',
    scope: 'schema:write',
  },
  deleteWidget: { method: 'DELETE', path: '/api/v1/widgets/{widgetId}', scope: 'schema:write' },
  duplicateDashboard: {
    method: 'POST',
    path: '/api/v1/dashboards/{dashboardId}/duplicate',
    scope: 'schema:write',
  },
  duplicateWidget: {
    method: 'POST',
    path: '/api/v1/widgets/{widgetId}/duplicate',
    scope: 'schema:write',
  },
  exportWidget: {
    method: 'GET',
    path: '/api/v1/widgets/{widgetId}/export',
    scope: 'records:read',
  },
  getDashboard: { method: 'GET', path: '/api/v1/dashboards/{dashboardId}', scope: 'schema:read' },
  listDashboardTrash: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/dashboards/trash',
    scope: 'schema:read',
  },
  listDashboards: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/dashboards',
    scope: 'schema:read',
  },
  restoreDashboard: {
    method: 'POST',
    path: '/api/v1/dashboards/{dashboardId}/restore',
    scope: 'schema:write',
  },
  updateDashboard: {
    method: 'PATCH',
    path: '/api/v1/dashboards/{dashboardId}',
    scope: 'schema:write',
  },
  updateDashboardLayout: {
    method: 'PUT',
    path: '/api/v1/dashboards/{dashboardId}/layout',
    scope: 'schema:write',
  },
  updateWidget: { method: 'PATCH', path: '/api/v1/widgets/{widgetId}', scope: 'schema:write' },
  widgetData: { method: 'POST', path: '/api/v1/widgets/{widgetId}/data', scope: 'records:read' },
  widgetOptions: {
    method: 'POST',
    path: '/api/v1/widgets/{widgetId}/options',
    scope: 'records:read',
  },
  widgetRecords: {
    method: 'POST',
    path: '/api/v1/widgets/{widgetId}/records',
    scope: 'records:read',
  },
  // email
  completeOrgEmailAssetUpload: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/email-assets/uploads/{assetId}/complete',
    scope: 'session',
  },
  confirmEmailVerification: {
    method: 'POST',
    path: '/api/v1/email-identities/verify',
    scope: 'public',
  },
  createEmailIdentity: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/email-identities',
    scope: 'session',
  },
  createOrgEmailAssetUpload: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/email-assets/uploads',
    scope: 'session',
  },
  deleteEmailIdentity: {
    method: 'DELETE',
    path: '/api/v1/email-identities/{identityId}',
    scope: 'session',
  },
  deleteOrgEmailAsset: {
    method: 'DELETE',
    path: '/api/v1/orgs/{orgId}/email-assets/{assetId}',
    scope: 'session',
  },
  disableEmailIdentity: {
    method: 'POST',
    path: '/api/v1/email-identities/{identityId}/disable',
    scope: 'session',
  },
  enableEmailIdentity: {
    method: 'POST',
    path: '/api/v1/email-identities/{identityId}/enable',
    scope: 'session',
  },
  getEmailIdentity: {
    method: 'GET',
    path: '/api/v1/email-identities/{identityId}',
    scope: 'session',
  },
  getEmailSettings: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/email-settings',
    scope: 'session',
  },
  getOrgEmailAsset: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/email-assets/{assetId}',
    scope: 'session',
  },
  listBaseEmailIdentities: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/email-identities',
    scope: 'session',
  },
  listEmailIdentities: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/email-identities',
    scope: 'session',
  },
  listEmailIdentityUsages: {
    method: 'GET',
    path: '/api/v1/email-identities/{identityId}/usages',
    scope: 'session',
  },
  previewEmailVerification: {
    method: 'POST',
    path: '/api/v1/email-identities/verify/preview',
    scope: 'public',
  },
  sendEmailIdentityVerification: {
    method: 'POST',
    path: '/api/v1/email-identities/{identityId}/send-verification',
    scope: 'session',
  },
  testAndVerifyEmailIdentity: {
    method: 'POST',
    path: '/api/v1/email-identities/{identityId}/test-and-verify',
    scope: 'session',
  },
  testEmailSettings: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/email-settings/test',
    scope: 'session',
  },
  updateEmailIdentity: {
    method: 'PATCH',
    path: '/api/v1/email-identities/{identityId}',
    scope: 'session',
  },
  updateEmailSettings: {
    method: 'PATCH',
    path: '/api/v1/orgs/{orgId}/email-settings',
    scope: 'session',
  },
  verifyEmailIdentityCode: {
    method: 'POST',
    path: '/api/v1/email-identities/{identityId}/verify-code',
    scope: 'session',
  },
  // export
  exportTable: { method: 'GET', path: '/api/v1/tables/{tableId}/export', scope: 'records:read' },
  // fields
  convertField: { method: 'PUT', path: '/api/v1/fields/{fieldId}', scope: 'schema:write' },
  createField: { method: 'POST', path: '/api/v1/tables/{tableId}/fields', scope: 'schema:write' },
  deleteField: { method: 'DELETE', path: '/api/v1/fields/{fieldId}', scope: 'schema:write' },
  getField: { method: 'GET', path: '/api/v1/fields/{fieldId}', scope: 'schema:read' },
  listFields: { method: 'GET', path: '/api/v1/tables/{tableId}/fields', scope: 'schema:read' },
  listLinkCandidates: {
    method: 'POST',
    path: '/api/v1/fields/{fieldId}/link-candidates',
    scope: 'records:read',
  },
  previewComputedField: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/computed-preview',
    scope: 'schema:write',
  },
  previewFieldConversion: {
    method: 'POST',
    path: '/api/v1/fields/{fieldId}/convert-preview',
    scope: 'schema:write',
  },
  previewFieldDelete: {
    method: 'GET',
    path: '/api/v1/fields/{fieldId}/delete-preview',
    scope: 'schema:write',
  },
  previewRevertFieldConversion: {
    method: 'POST',
    path: '/api/v1/fields/{fieldId}/revert-conversion/preview',
    scope: 'schema:write',
  },
  restoreField: { method: 'POST', path: '/api/v1/fields/{fieldId}/restore', scope: 'schema:write' },
  revertFieldConversion: {
    method: 'POST',
    path: '/api/v1/fields/{fieldId}/revert-conversion',
    scope: 'schema:write',
  },
  updateField: { method: 'PATCH', path: '/api/v1/fields/{fieldId}', scope: 'schema:write' },
  // files
  attachmentThumbnail: {
    method: 'GET',
    path: '/api/v1/files/{attachmentId}/thumbnail',
    scope: 'records:read',
  },
  completeUpload: {
    method: 'POST',
    path: '/api/v1/files/uploads/{attachmentId}/complete',
    scope: 'records:write',
  },
  createUpload: { method: 'POST', path: '/api/v1/files/uploads', scope: 'records:write' },
  downloadAttachment: {
    method: 'GET',
    path: '/api/v1/files/{attachmentId}',
    scope: 'records:read',
  },
  // forms
  completeFormCoverUpload: {
    method: 'POST',
    path: '/api/v1/views/{viewId}/form-cover/uploads/{attachmentId}/complete',
    scope: 'schema:write',
  },
  completeSharedFormUpload: {
    method: 'POST',
    path: '/api/v1/shares/{token}/uploads/{attachmentId}/complete',
    scope: 'public',
  },
  createFormCoverUpload: {
    method: 'POST',
    path: '/api/v1/views/{viewId}/form-cover/uploads',
    scope: 'schema:write',
  },
  createSharedFormUpload: {
    method: 'POST',
    path: '/api/v1/shares/{token}/uploads',
    scope: 'public',
  },
  formCover: {
    method: 'GET',
    path: '/api/v1/views/{viewId}/form-cover/{attachmentId}',
    scope: 'schema:read',
  },
  getFormSubmissionStatus: {
    method: 'GET',
    path: '/api/v1/views/{viewId}/submission-status',
    scope: 'records:read',
  },
  getFormSubmitToken: {
    method: 'GET',
    path: '/api/v1/shares/{token}/submit-token',
    scope: 'public',
  },
  getSharedFormSubmissionStatus: {
    method: 'GET',
    path: '/api/v1/shares/{token}/submission-status',
    scope: 'public',
  },
  listSharedFormLinkCandidates: {
    method: 'GET',
    path: '/api/v1/shares/{token}/link-candidates/{fieldId}',
    scope: 'public',
  },
  listSharedFormMembers: { method: 'GET', path: '/api/v1/shares/{token}/members', scope: 'public' },
  sharedFormCover: {
    method: 'GET',
    path: '/api/v1/shares/{token}/form-cover/{attachmentId}',
    scope: 'public',
  },
  submitForm: { method: 'POST', path: '/api/v1/views/{viewId}/submit', scope: 'records:write' },
  submitSharedForm: { method: 'POST', path: '/api/v1/shares/{token}/submit', scope: 'public' },
  // groups
  addGroupMember: { method: 'POST', path: '/api/v1/groups/{groupId}/members', scope: 'session' },
  createGroup: { method: 'POST', path: '/api/v1/orgs/{orgId}/groups', scope: 'session' },
  deleteGroup: {
    method: 'DELETE',
    path: '/api/v1/orgs/{orgId}/groups/{groupId}',
    scope: 'session',
  },
  getGroup: { method: 'GET', path: '/api/v1/orgs/{orgId}/groups/{groupId}', scope: 'session' },
  listGroupMembers: { method: 'GET', path: '/api/v1/groups/{groupId}/members', scope: 'session' },
  listGroups: { method: 'GET', path: '/api/v1/orgs/{orgId}/groups', scope: 'session' },
  removeGroupMember: {
    method: 'DELETE',
    path: '/api/v1/groups/{groupId}/members/{userId}',
    scope: 'session',
  },
  updateGroup: { method: 'PATCH', path: '/api/v1/orgs/{orgId}/groups/{groupId}', scope: 'session' },
  // http-allowlist
  createHttpAllowlistEntry: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/http-allowlist',
    scope: 'session',
  },
  deleteHttpAllowlistEntry: {
    method: 'DELETE',
    path: '/api/v1/http-allowlist/{allowlistEntryId}',
    scope: 'session',
  },
  listHttpAllowlist: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/http-allowlist',
    scope: 'session',
  },
  // imports
  cancelImport: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/imports/{jobId}/cancel',
    scope: 'records:write',
  },
  previewImport: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/imports/uploads/{uploadId}/preview',
    scope: 'records:write',
  },
  startImport: { method: 'POST', path: '/api/v1/bases/{baseId}/imports', scope: 'records:write' },
  uploadImportFile: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/imports/uploads',
    scope: 'records:write',
  },
  // incoming-webhooks
  createIncomingWebhook: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/incoming-webhooks',
    scope: 'automations:write',
  },
  deleteIncomingWebhook: {
    method: 'DELETE',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}',
    scope: 'automations:write',
  },
  deleteIncomingWebhookBearer: {
    method: 'DELETE',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/bearer',
    scope: 'automations:write',
  },
  // Returns the hook URL, which anyone can call to start runs: a write capability.
  getIncomingWebhook: {
    method: 'GET',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}',
    scope: 'automations:write',
  },
  getIncomingWebhookSample: {
    method: 'GET',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/sample',
    scope: 'automations:read',
  },
  listenIncomingWebhookSample: {
    method: 'POST',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/listen',
    scope: 'automations:write',
  },
  listIncomingWebhookRequests: {
    method: 'GET',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/requests',
    scope: 'automations:read',
  },
  // Returns the hook URL, which anyone can call to start runs: a write capability.
  listIncomingWebhooks: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/incoming-webhooks',
    scope: 'automations:write',
  },
  receiveIncomingWebhook: { method: 'POST', path: '/api/v1/hooks/{token}', scope: 'public' },
  regenerateIncomingWebhookToken: {
    method: 'POST',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/regenerate-token',
    scope: 'automations:write',
  },
  rotateIncomingWebhookSecret: {
    method: 'POST',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/rotate-secret',
    scope: 'automations:write',
  },
  setIncomingWebhookBearer: {
    method: 'PUT',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/bearer',
    scope: 'automations:write',
  },
  stopListeningIncomingWebhookSample: {
    method: 'DELETE',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}/listen',
    scope: 'automations:write',
  },
  updateIncomingWebhook: {
    method: 'PATCH',
    path: '/api/v1/incoming-webhooks/{incomingWebhookId}',
    scope: 'automations:write',
  },
  // invitations
  acceptInvitation: { method: 'POST', path: '/api/v1/invitations/{token}/accept', scope: 'public' },
  createInvitation: { method: 'POST', path: '/api/v1/orgs/{orgId}/invitations', scope: 'session' },
  getInvitation: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/invitations/{invitationId}',
    scope: 'session',
  },
  listInvitations: { method: 'GET', path: '/api/v1/orgs/{orgId}/invitations', scope: 'session' },
  previewInvitation: { method: 'GET', path: '/api/v1/invitations/{token}', scope: 'public' },
  revokeInvitation: {
    method: 'DELETE',
    path: '/api/v1/orgs/{orgId}/invitations/{invitationId}',
    scope: 'session',
  },
  // jobs
  downloadExport: { method: 'GET', path: '/api/v1/files/exports/{jobId}', scope: 'records:read' },
  getJob: { method: 'GET', path: '/api/v1/jobs/{jobId}', scope: 'records:read' },
  // notifications
  countMyUnreadNotifications: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/me/notifications/unread-count',
    scope: 'session',
  },
  createMyTelegramLink: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/me/channels/telegram',
    scope: 'session',
  },
  getMyNotificationPreferences: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/me/notification-preferences',
    scope: 'session',
  },
  getMyNotificationSettings: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/me/notification-settings',
    scope: 'session',
  },
  getOrgNotificationChannels: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/notification-channels',
    scope: 'session',
  },
  listMyChannels: { method: 'GET', path: '/api/v1/orgs/{orgId}/me/channels', scope: 'session' },
  listMyNotifications: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/me/notifications',
    scope: 'session',
  },
  markMyNotificationsRead: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/me/notifications/read',
    scope: 'session',
  },
  muteBaseNotifications: {
    method: 'PUT',
    path: '/api/v1/orgs/{orgId}/me/notification-mutes/bases/{baseId}',
    scope: 'session',
  },
  unlinkMyTelegram: {
    method: 'DELETE',
    path: '/api/v1/orgs/{orgId}/me/channels/telegram',
    scope: 'session',
  },
  unmuteBaseNotifications: {
    method: 'DELETE',
    path: '/api/v1/orgs/{orgId}/me/notification-mutes/bases/{baseId}',
    scope: 'session',
  },
  updateMyNotificationPreferences: {
    method: 'PUT',
    path: '/api/v1/orgs/{orgId}/me/notification-preferences',
    scope: 'session',
  },
  updateMyNotificationSettings: {
    method: 'PUT',
    path: '/api/v1/orgs/{orgId}/me/notification-settings',
    scope: 'session',
  },
  updateOrgNotificationChannels: {
    method: 'PATCH',
    path: '/api/v1/orgs/{orgId}/notification-channels',
    scope: 'session',
  },
  // org-members
  getOrgMember: { method: 'GET', path: '/api/v1/orgs/{orgId}/members/{userId}', scope: 'session' },
  listOrgMembers: { method: 'GET', path: '/api/v1/orgs/{orgId}/members', scope: 'session' },
  removeOrgMember: {
    method: 'DELETE',
    path: '/api/v1/orgs/{orgId}/members/{userId}',
    scope: 'session',
  },
  updateOrgMember: {
    method: 'PATCH',
    path: '/api/v1/orgs/{orgId}/members/{userId}',
    scope: 'session',
  },
  // orgs
  createOrganization: { method: 'POST', path: '/api/v1/orgs', scope: 'session' },
  getOrganization: { method: 'GET', path: '/api/v1/orgs/{orgId}', scope: 'schema:read' },
  listOrganizations: { method: 'GET', path: '/api/v1/orgs', scope: 'schema:read' },
  updateOrganization: { method: 'PATCH', path: '/api/v1/orgs/{orgId}', scope: 'session' },
  // records
  countRecordGroups: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/group-counts',
    scope: 'records:read',
  },
  createRecords: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records',
    scope: 'records:write',
  },
  deleteRecord: {
    method: 'DELETE',
    path: '/api/v1/tables/{tableId}/records/{recordId}',
    scope: 'records:write',
  },
  deleteRecords: {
    method: 'DELETE',
    path: '/api/v1/tables/{tableId}/records',
    scope: 'records:write',
  },
  followRecord: {
    method: 'PUT',
    path: '/api/v1/tables/{tableId}/records/{recordId}/follow',
    scope: 'session',
  },
  getRecord: {
    method: 'GET',
    path: '/api/v1/tables/{tableId}/records/{recordId}',
    scope: 'records:read',
  },
  getRecordFollow: {
    method: 'GET',
    path: '/api/v1/tables/{tableId}/records/{recordId}/follow',
    scope: 'session',
  },
  getRecordHistory: {
    method: 'GET',
    path: '/api/v1/tables/{tableId}/records/{recordId}/history',
    scope: 'records:read',
  },
  listRecordAncestors: {
    method: 'GET',
    path: '/api/v1/tables/{tableId}/records/{recordId}/ancestors',
    scope: 'records:read',
  },
  listRecordChildren: {
    method: 'GET',
    path: '/api/v1/tables/{tableId}/records/{recordId}/children',
    scope: 'records:read',
  },
  listRecords: { method: 'GET', path: '/api/v1/tables/{tableId}/records', scope: 'records:read' },
  listRecordTrash: {
    method: 'GET',
    path: '/api/v1/tables/{tableId}/records/trash',
    scope: 'records:read',
  },
  purgeRecords: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/trash/purge',
    scope: 'records:write',
  },
  queryRecords: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/query',
    scope: 'records:read',
  },
  queryRecordTree: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/tree',
    scope: 'records:read',
  },
  restoreRecords: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/restore',
    scope: 'records:write',
  },
  revertRecord: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/{recordId}/revert',
    scope: 'records:write',
  },
  summarizeRecords: {
    method: 'POST',
    path: '/api/v1/tables/{tableId}/records/summaries',
    scope: 'records:read',
  },
  unfollowRecord: {
    method: 'DELETE',
    path: '/api/v1/tables/{tableId}/records/{recordId}/follow',
    scope: 'session',
  },
  updateRecord: {
    method: 'PATCH',
    path: '/api/v1/tables/{tableId}/records/{recordId}',
    scope: 'records:write',
  },
  updateRecords: {
    method: 'PATCH',
    path: '/api/v1/tables/{tableId}/records',
    scope: 'records:write',
  },
  // roles
  assignRole: { method: 'PUT', path: '/api/v1/bases/{baseId}/role-assignments', scope: 'session' },
  createRole: { method: 'POST', path: '/api/v1/bases/{baseId}/roles', scope: 'session' },
  deleteRole: { method: 'DELETE', path: '/api/v1/bases/{baseId}/roles/{roleId}', scope: 'session' },
  getRole: { method: 'GET', path: '/api/v1/bases/{baseId}/roles/{roleId}', scope: 'session' },
  listRoles: { method: 'GET', path: '/api/v1/bases/{baseId}/roles', scope: 'session' },
  removeRoleAssignment: {
    method: 'DELETE',
    path: '/api/v1/bases/{baseId}/role-assignments',
    scope: 'session',
  },
  updateRole: { method: 'PATCH', path: '/api/v1/bases/{baseId}/roles/{roleId}', scope: 'session' },
  // member access (T711)
  getMemberAccess: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/members/{userId}/access',
    scope: 'session',
  },
  listBasePrincipals: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/principals',
    scope: 'session',
  },
  // secrets
  createSecret: { method: 'POST', path: '/api/v1/orgs/{orgId}/secrets', scope: 'session' },
  deleteSecret: { method: 'DELETE', path: '/api/v1/secrets/{secretId}', scope: 'session' },
  listBaseSecrets: { method: 'GET', path: '/api/v1/bases/{baseId}/secrets', scope: 'session' },
  listSecrets: { method: 'GET', path: '/api/v1/orgs/{orgId}/secrets', scope: 'session' },
  listSecretUsages: { method: 'GET', path: '/api/v1/secrets/{secretId}/usages', scope: 'session' },
  updateSecret: { method: 'PATCH', path: '/api/v1/secrets/{secretId}', scope: 'session' },
  // setup
  completeSetup: { method: 'POST', path: '/api/v1/setup', scope: 'public' },
  getSetupStatus: { method: 'GET', path: '/api/v1/setup', scope: 'public' },
  // share-links
  createDashboardShareLink: {
    method: 'POST',
    path: '/api/v1/dashboards/{dashboardId}/share-links',
    scope: 'session',
  },
  createShareLink: { method: 'POST', path: '/api/v1/views/{viewId}/share-links', scope: 'session' },
  getShareLink: { method: 'GET', path: '/api/v1/share-links/{shareLinkId}', scope: 'session' },
  listBaseShareLinks: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/share-links',
    scope: 'session',
  },
  listDashboardShareLinks: {
    method: 'GET',
    path: '/api/v1/dashboards/{dashboardId}/share-links',
    scope: 'session',
  },
  listOrgShareLinks: { method: 'GET', path: '/api/v1/orgs/{orgId}/share-links', scope: 'session' },
  listViewShareLinks: {
    method: 'GET',
    path: '/api/v1/views/{viewId}/share-links',
    scope: 'session',
  },
  previewShareLink: {
    method: 'GET',
    path: '/api/v1/views/{viewId}/share-links/preview',
    scope: 'session',
  },
  regenerateShareLink: {
    method: 'POST',
    path: '/api/v1/share-links/{shareLinkId}/regenerate',
    scope: 'session',
  },
  revokeBaseShareLinks: {
    method: 'POST',
    path: '/api/v1/bases/{baseId}/share-links/revoke',
    scope: 'session',
  },
  revokeOrgShareLinks: {
    method: 'POST',
    path: '/api/v1/orgs/{orgId}/share-links/revoke',
    scope: 'session',
  },
  revokeShareLink: {
    method: 'DELETE',
    path: '/api/v1/share-links/{shareLinkId}',
    scope: 'session',
  },
  updateShareLink: { method: 'PATCH', path: '/api/v1/share-links/{shareLinkId}', scope: 'session' },
  // shares
  countShareRecordGroups: {
    method: 'POST',
    path: '/api/v1/shares/{token}/records/group-counts',
    scope: 'public',
  },
  downloadShareAttachment: {
    method: 'GET',
    path: '/api/v1/shares/{token}/files/{attachmentId}',
    scope: 'public',
  },
  exportSharedWidget: {
    method: 'GET',
    path: '/api/v1/shares/{token}/widgets/{widgetId}/export',
    scope: 'public',
  },
  exportShareView: { method: 'GET', path: '/api/v1/shares/{token}/export', scope: 'public' },
  getSharedDashboard: { method: 'GET', path: '/api/v1/shares/{token}/dashboard', scope: 'public' },
  getShareMeta: { method: 'GET', path: '/api/v1/shares/{token}/meta', scope: 'public' },
  getSharePageHeaders: { method: 'GET', path: '/api/v1/shares/{token}/page', scope: 'public' },
  getShareRecord: {
    method: 'GET',
    path: '/api/v1/shares/{token}/records/{recordId}',
    scope: 'public',
  },
  queryShareRecords: {
    method: 'POST',
    path: '/api/v1/shares/{token}/records/query',
    scope: 'public',
  },
  sharedWidgetData: {
    method: 'POST',
    path: '/api/v1/shares/{token}/widgets/{widgetId}/data',
    scope: 'public',
  },
  sharedWidgetOptions: {
    method: 'POST',
    path: '/api/v1/shares/{token}/widgets/{widgetId}/options',
    scope: 'public',
  },
  shareAttachmentThumbnail: {
    method: 'GET',
    path: '/api/v1/shares/{token}/files/{attachmentId}/thumbnail',
    scope: 'public',
  },
  summarizeShareRecords: {
    method: 'POST',
    path: '/api/v1/shares/{token}/records/summaries',
    scope: 'public',
  },
  unlockShare: { method: 'POST', path: '/api/v1/shares/{token}/unlock', scope: 'public' },
  // system
  getHealthz: { method: 'GET', path: '/healthz', scope: 'public' },
  getOpenApiDocument: { method: 'GET', path: '/api/v1/openapi.json', scope: 'public' },
  getReadyz: { method: 'GET', path: '/readyz', scope: 'public' },
  // tables
  createTable: { method: 'POST', path: '/api/v1/bases/{baseId}/tables', scope: 'schema:write' },
  deleteTable: { method: 'DELETE', path: '/api/v1/tables/{tableId}', scope: 'schema:write' },
  getTable: { method: 'GET', path: '/api/v1/tables/{tableId}', scope: 'schema:read' },
  listTables: { method: 'GET', path: '/api/v1/bases/{baseId}/tables', scope: 'schema:read' },
  listTrashedTables: {
    method: 'GET',
    path: '/api/v1/bases/{baseId}/tables/trash',
    scope: 'schema:read',
  },
  previewTableDelete: {
    method: 'GET',
    path: '/api/v1/tables/{tableId}/delete-preview',
    scope: 'schema:write',
  },
  purgeTable: { method: 'POST', path: '/api/v1/tables/{tableId}/purge', scope: 'schema:write' },
  restoreTable: { method: 'POST', path: '/api/v1/tables/{tableId}/restore', scope: 'schema:write' },
  updateTable: { method: 'PATCH', path: '/api/v1/tables/{tableId}', scope: 'schema:write' },
  // views
  createView: { method: 'POST', path: '/api/v1/tables/{tableId}/views', scope: 'schema:write' },
  deleteView: { method: 'DELETE', path: '/api/v1/views/{viewId}', scope: 'schema:write' },
  duplicateView: {
    method: 'POST',
    path: '/api/v1/views/{viewId}/duplicate',
    scope: 'schema:write',
  },
  getView: { method: 'GET', path: '/api/v1/views/{viewId}', scope: 'schema:read' },
  listViews: { method: 'GET', path: '/api/v1/tables/{tableId}/views', scope: 'schema:read' },
  updateView: { method: 'PATCH', path: '/api/v1/views/{viewId}', scope: 'schema:write' },
  // workspaces
  addWorkspaceMember: {
    method: 'POST',
    path: '/api/v1/workspaces/{workspaceId}/members',
    scope: 'session',
  },
  createWorkspace: { method: 'POST', path: '/api/v1/orgs/{orgId}/workspaces', scope: 'session' },
  deleteWorkspace: {
    method: 'DELETE',
    path: '/api/v1/orgs/{orgId}/workspaces/{workspaceId}',
    scope: 'session',
  },
  getWorkspace: {
    method: 'GET',
    path: '/api/v1/orgs/{orgId}/workspaces/{workspaceId}',
    scope: 'schema:read',
  },
  listWorkspaceMembers: {
    method: 'GET',
    path: '/api/v1/workspaces/{workspaceId}/members',
    scope: 'session',
  },
  listWorkspaces: { method: 'GET', path: '/api/v1/orgs/{orgId}/workspaces', scope: 'schema:read' },
  removeWorkspaceMember: {
    method: 'DELETE',
    path: '/api/v1/workspaces/{workspaceId}/members/{principalId}',
    scope: 'session',
  },
  updateWorkspace: {
    method: 'PATCH',
    path: '/api/v1/orgs/{orgId}/workspaces/{workspaceId}',
    scope: 'session',
  },
  updateWorkspaceMember: {
    method: 'PATCH',
    path: '/api/v1/workspaces/{workspaceId}/members/{principalId}',
    scope: 'session',
  },
} as const satisfies Readonly<Record<string, ApiTokenRouteEntry>>;

export type ApiTokenOperationId = keyof typeof API_TOKEN_ROUTE_SCOPES;

/**
 * Normalised `METHOD path` of a route, every parameter name dropped, so that
 * the OpenAPI path (`/tables/{tableId}`) and the server route pattern
 * (`/tables/:tableId`) of one route compare equal: `GET /tables/{}`.
 */
export function apiTokenRouteKey(method: string, path: string): string {
  const normalised = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') || (segment.startsWith('{') && segment.endsWith('}'))
        ? '{}'
        : segment,
    )
    .join('/');
  return `${method.toUpperCase()} ${normalised}`;
}

export type IndexedApiTokenRoute = ApiTokenRouteEntry & { readonly operationId: string };

/** Entries by `apiTokenRouteKey`, for the request-time lookup. */
export function apiTokenRouteIndex(
  table: Readonly<Record<string, ApiTokenRouteEntry>> = API_TOKEN_ROUTE_SCOPES,
): ReadonlyMap<string, IndexedApiTokenRoute> {
  const index = new Map<string, IndexedApiTokenRoute>();
  for (const [operationId, entry] of Object.entries(table)) {
    index.set(apiTokenRouteKey(entry.method, entry.path), { ...entry, operationId });
  }
  return index;
}
