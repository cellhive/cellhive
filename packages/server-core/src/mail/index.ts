export { sanitizeEmailHtml } from './render/sanitize.js';
export {
  domainOf,
  maskAddress,
  normalizeAddress,
  normalizeRecipients,
  sanitizeHeaderText,
  type NormalizedRecipients,
  type RecipientLists,
} from './address.js';
export {
  AUTOMATION_HEADER,
  deterministicMessageId,
  isValidMessageId,
  mandatoryHeaders,
  type MailOrigin,
} from './headers.js';
export {
  EMAIL_COLORS,
  EMAIL_ELEMENT_STYLES,
  EMAIL_MAX_WIDTH_PX,
  renderEmailLayout,
  TEXT_FOOTER_SEPARATOR,
  type EmailBody,
  type EmailBodyRenderer,
  type EmailLayoutInput,
} from './layout.js';
export {
  createValkeyEmailQuota,
  createValkeySendPacer,
  EMAIL_QUOTA_MAX_WAIT_MS,
  MemorySendPacer,
  SEND_SLOT_LEASE_MS,
  SendPacerUnavailableError,
  SendRateLimiter,
  systemClock,
  VALKEY_READY_TIMEOUT_MS,
  valkeyQuotaClient,
  valkeyReady,
  type Clock,
  type EmailQuota,
  type QuotaClient,
  type QuotaDecision,
  type SendPacer,
  type SendPacerOptions,
  type SendSlot,
  type ValkeyConnection,
  type ValkeyEmailQuotaOptions,
  type ValkeyScriptClient,
  type ValkeySendPacerOptions,
} from './limits.js';
export {
  createMailer,
  createMailService,
  describeSmtp,
  type CreateMailerOptions,
  type MailAddress,
  type MailAttachment,
  type MailMessage,
  type Mailer,
  type MailSendResult,
  type SmtpDescription,
} from './mailer.js';
export {
  classifySmtpError,
  EmailSendError,
  isEmailSendError,
  smtpReplyOf,
  type RejectedRecipient,
  type SmtpFailure,
  type SmtpReply,
} from './smtp-errors.js';
export {
  connectionTestEmail,
  escapeHtml,
  invitationEmail,
  MAIL_LOCALES,
  mailLocaleOf,
  passwordResetEmail,
  type ConnectionTestEmailInput,
  type InvitationEmailInput,
  type MailLocale,
  type PasswordResetEmailInput,
} from './templates.js';
export {
  notificationItemHeadline,
  renderNotificationEmail,
  type NotificationEmailInput,
  type NotificationEmailItem,
  type RenderedNotificationEmail,
} from './templates/notification-email.js';
export {
  defaultTransportFactory,
  IdentityTransportCache,
  INSTANCE_TRANSPORT,
  instanceEndpoint,
  maskHost,
  SMTP_TIMEOUTS,
  transportOptions,
  type MailTransportRef,
  type SmtpCredentials,
  type SmtpEndpoint,
  type TransportBuildOptions,
  type TransportFactory,
} from './transport.js';
export * from './identities/index.js';
export * from './images/index.js';
export {
  automationUrlOf,
  footerBlocks,
  footerNoneAllowedByPolicy,
  resolveFooter,
  senderMayOmitFooter,
  type FooterAutomation,
  type FooterContent,
  type FooterPolicyInput,
  type FooterRefusal,
  type FooterSender,
  type ResolveFooterInput,
  type ResolveFooterResult,
} from './footer/footer.js';
export {
  checkSignature,
  checkSignatureAssets,
  SIGNATURE_IMAGE_SOURCES,
  signatureAssetIds,
  signatureBlocks,
  signatureInput,
  type SignatureIssue,
  type SignatureIssueCode,
} from './signature/signature.js';
export {
  DEFAULT_ORG_EMAIL_SETTINGS,
  effectiveAttachmentLimits,
  orgEmailSettingsJson,
  orgEmailSettingsOf,
  type EmailAttachmentLimits,
  type OrgEmailSettings,
} from './settings/org-email-settings.js';
export {
  SystemSenderUsageRepository,
  type SystemSenderUsage,
} from './settings/system-sender-usage.repository.js';
export {
  automationEmailImages,
  composeAutomationEmail,
  signatureSourceOf,
  type AutomationEmailImages,
  type ComposeAutomationEmailInput,
  type ComposeAutomationEmailResult,
  type ComposedAutomationEmail,
} from './automation-email/compose.js';
