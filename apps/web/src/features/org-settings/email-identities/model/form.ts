import {
  displayNameIssueOf,
  EMAIL_IDENTITY_DISPLAY_NAME_MAX,
  type CreateEmailIdentityRequest,
  type DisplayNameIssue,
  type EmailIdentityBaseScope,
  type EmailIdentityDto,
  type EmailIdentitySmtpPort,
  type EmailIdentityTransport,
  type SmtpSecurity,
  type UpdateEmailIdentityRequest,
} from '@cellhive/contracts';

import { domainOf } from './sender';
import { signatureIssue } from './signature';

/**
 * The add/edit form of a sender identity (T533) as plain data: its
 * defaults, client-side checks (the server checks again) and the request
 * it sends — on edit only what changed, the SMTP password only when typed.
 */
export interface IdentityFormState {
  readonly email: string;
  readonly displayName: string;
  readonly replyTo: string;
  readonly transport: EmailIdentityTransport;
  readonly host: string;
  readonly port: EmailIdentitySmtpPort;
  readonly security: SmtpSecurity;
  readonly username: string;
  /** Typed password; `''` = keep the stored one (edit) / missing (create). */
  readonly password: string;
  /** Edit with a stored password: the "Change password" field is open. */
  readonly changePassword: boolean;
  /** `security = none` confirmed (sent as `allow_insecure`). */
  readonly allowInsecure: boolean;
  readonly baseScope: EmailIdentityBaseScope;
  readonly baseIds: readonly string[];
  readonly signature: string;
}

type BaseId = NonNullable<UpdateEmailIdentityRequest['base_ids']>[number];

export const DEFAULT_PORT: Record<SmtpSecurity, EmailIdentitySmtpPort> = {
  starttls: 587,
  tls: 465,
  none: 25,
};

export function initialForm(identity: EmailIdentityDto | null): IdentityFormState {
  if (identity === null) {
    return {
      email: '',
      displayName: '',
      replyTo: '',
      transport: 'system',
      host: '',
      port: 587,
      security: 'starttls',
      username: '',
      password: '',
      changePassword: false,
      allowInsecure: false,
      baseScope: 'all',
      baseIds: [],
      signature: '',
    };
  }
  const smtp = identity.smtp;
  return {
    email: identity.email,
    displayName: identity.display_name,
    replyTo: identity.reply_to ?? '',
    transport: identity.transport,
    host: smtp?.host ?? '',
    port: (smtp?.port ?? 587) as EmailIdentitySmtpPort,
    security: smtp?.security ?? 'starttls',
    username: smtp?.username ?? '',
    password: '',
    changePassword: false,
    allowInsecure: smtp?.security === 'none',
    baseScope: identity.base_scope,
    baseIds: identity.base_ids,
    signature: identity.signature_md ?? '',
  };
}

/** Whether a stored password exists and is kept (no new one typed). */
export function keepsStoredPassword(
  identity: EmailIdentityDto | null,
  form: IdentityFormState,
): boolean {
  return identity?.smtp != null && form.transport === 'smtp' && !form.changePassword;
}

/** Form field → message key (`form.errors.<key>`). */
export type FormErrors = Partial<
  Record<
    | 'email'
    | 'displayName'
    | 'replyTo'
    | 'host'
    | 'username'
    | 'password'
    | 'allowInsecure'
    | 'baseIds',
    string
  >
>;

/**
 * (T556, QA S5 M7) Why the server would refuse the display name as typed
 * (`DISPLAY_NAME_NOT_ALLOWED`, same helper as the API — CONTRACTS §23.3),
 * `null` when it would not.
 */
export function displayNameIssue(
  form: Pick<IdentityFormState, 'displayName'>,
): DisplayNameIssue | null {
  const name = form.displayName.trim();
  return name === '' ? null : displayNameIssueOf(name);
}

/**
 * Whether the save sends a new display name. A name saved before T540 that
 * would be refused today may stay while other settings change (a `PATCH`
 * without `display_name` keeps it, CONTRACTS §23.3); a new one must pass.
 */
export function displayNameChanged(
  identity: EmailIdentityDto | null,
  form: Pick<IdentityFormState, 'displayName'>,
): boolean {
  return identity === null || form.displayName.trim() !== identity.display_name;
}

/** Client checks before sending (message keys, translated by the form). */
export function checkForm(identity: EmailIdentityDto | null, form: IdentityFormState): FormErrors {
  const errors: FormErrors = {};
  if (form.email.trim() === '') errors.email = 'required';
  else if (domainOf(form.email) === null) errors.email = 'invalidEmail';
  if (form.displayName.trim() === '') errors.displayName = 'required';
  else if (form.displayName.trim().length > EMAIL_IDENTITY_DISPLAY_NAME_MAX) {
    errors.displayName = 'tooLong';
  } else if (displayNameIssue(form) !== null && displayNameChanged(identity, form)) {
    // Worded by reason from `displayNameIssue` (the server answers the same, T540).
    errors.displayName = 'notAllowed';
  }
  if (form.replyTo.trim() !== '' && domainOf(form.replyTo) === null) {
    errors.replyTo = 'invalidEmail';
  }
  if (form.transport === 'smtp') {
    if (form.host.trim() === '') errors.host = 'required';
    if (form.username.trim() === '') errors.username = 'required';
    if (!keepsStoredPassword(identity, form) && form.password === '') errors.password = 'required';
    if (form.security === 'none' && !form.allowInsecure) errors.allowInsecure = 'confirmInsecure';
  }
  if (form.baseScope === 'selected' && form.baseIds.length === 0) errors.baseIds = 'pickBase';
  return errors;
}

export function hasErrors(errors: FormErrors, form: IdentityFormState): boolean {
  return Object.keys(errors).length > 0 || signatureIssue(form.signature) !== null;
}

function smtpInput(form: IdentityFormState, withPassword: boolean) {
  return {
    host: form.host.trim(),
    port: form.port,
    security: form.security,
    username: form.username.trim(),
    ...(withPassword ? { password: form.password } : {}),
    ...(form.security === 'none' ? { allow_insecure: true } : {}),
  };
}

const signatureOf = (form: IdentityFormState) =>
  form.signature.trim() === '' ? null : form.signature;

export function createRequest(form: IdentityFormState): CreateEmailIdentityRequest {
  return {
    email: form.email.trim(),
    display_name: form.displayName.trim(),
    reply_to: form.replyTo.trim() === '' ? null : form.replyTo.trim(),
    transport: form.transport,
    ...(form.transport === 'smtp' ? { smtp: smtpInput(form, true) } : {}),
    base_scope: form.baseScope,
    base_ids: form.baseScope === 'selected' ? [...form.baseIds] : [],
    signature_md: signatureOf(form),
  };
}

/** Only the keys that changed; `{}` when nothing did. */
export function updateRequest(
  identity: EmailIdentityDto,
  form: IdentityFormState,
): UpdateEmailIdentityRequest {
  const body: UpdateEmailIdentityRequest = {};
  const email = form.email.trim();
  if (email.toLowerCase() !== identity.email) body.email = email;
  const name = form.displayName.trim();
  if (name !== identity.display_name) body.display_name = name;
  const replyTo = form.replyTo.trim() === '' ? null : form.replyTo.trim().toLowerCase();
  if (replyTo !== identity.reply_to) body.reply_to = replyTo;
  if (form.transport !== identity.transport) body.transport = form.transport;
  if (form.transport === 'smtp') {
    const smtp = identity.smtp;
    const typed = !keepsStoredPassword(identity, form) && form.password !== '';
    const changed =
      smtp === null ||
      typed ||
      smtp.host !== form.host.trim() ||
      smtp.port !== form.port ||
      smtp.security !== form.security ||
      smtp.username !== form.username.trim();
    if (changed) body.smtp = smtpInput(form, typed);
  }
  if (form.baseScope !== identity.base_scope) body.base_scope = form.baseScope;
  const baseIds = form.baseScope === 'selected' ? [...form.baseIds].sort() : [];
  const before = [...identity.base_ids].sort();
  if (form.baseScope === 'selected' && baseIds.join() !== before.join())
    body.base_ids = baseIds as BaseId[];
  const signature = signatureOf(form);
  if (signature !== identity.signature_md) body.signature_md = signature;
  return body;
}

/**
 * Whether saving makes the identity `pending` again (CONTRACTS §23.3): a
 * new address or transport, or (own SMTP) a new host, user name or password.
 * Port and security only rebuild the connection.
 */
export function needsReverification(identity: EmailIdentityDto, form: IdentityFormState): boolean {
  if (form.email.trim().toLowerCase() !== identity.email) return true;
  if (form.transport !== identity.transport) return true;
  if (form.transport !== 'smtp' || identity.smtp === null) return false;
  return (
    identity.smtp.host !== form.host.trim().toLowerCase() ||
    identity.smtp.username !== form.username.trim() ||
    (!keepsStoredPassword(identity, form) && form.password !== '')
  );
}

/** `errors[].path` of the API → the form field it belongs to. */
export const SERVER_PATHS: Readonly<Partial<Record<string, keyof FormErrors | 'signature'>>> = {
  email: 'email',
  display_name: 'displayName',
  reply_to: 'replyTo',
  'smtp.host': 'host',
  'smtp.username': 'username',
  'smtp.password': 'password',
  'smtp.allow_insecure': 'allowInsecure',
  base_ids: 'baseIds',
  signature_md: 'signature',
};
