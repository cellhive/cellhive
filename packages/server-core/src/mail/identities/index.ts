export {
  EmailIdentitiesRepository,
  type AuthFailureResult,
  type EmailIdentityPatch,
  type NewEmailIdentity,
} from './email-identities.repository.js';
export {
  EmailIdentityVerificationsRepository,
  type IssueVerificationInput,
} from './email-identity-verifications.repository.js';
export {
  EmailIdentityUsageRepository,
  MAX_IDENTITY_USAGES,
  type EmailIdentityUsageRow,
} from './identity-usage.repository.js';
export {
  classifyAddress,
  guardedSmtpSocket,
  normalizeSmtpHost,
  resolveAllowedSmtpHost,
  SmtpHostError,
  systemHostLookup,
  type AddressClass,
  type HostGuardOptions,
  type HostLookup,
  type SmtpGetSocket,
  type SmtpHostProblem,
} from './host-guard.js';
export {
  recordIdentitySendOutcome,
  type IdentitySendOutcome,
  type IdentitySendOutcomeDeps,
} from './send-outcome.js';
export {
  identityHintsOf,
  identityModeOf,
  identityTransportOf,
  onBehalfName,
  resolveSender,
  senderDisplayOf,
  senderHeadersOf,
  type ResolvedSender,
  type ResolveSenderResult,
  type SenderHeaders,
  type SenderResolverDeps,
  verificationSenderOf,
} from './sender.js';
export {
  senderVerificationEmail,
  type SenderVerificationEmailInput,
} from './verification-email.js';
export {
  EMAIL_VERIFICATION_TTL_MS,
  issueVerification,
  parseVerificationToken,
  verificationCodeHash,
  verificationCodeMatches,
  verifySenderUrlOf,
  type IssuedVerification,
} from './verification.js';
