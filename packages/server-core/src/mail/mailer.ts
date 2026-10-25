import { Buffer } from 'node:buffer';

import {
  domainOf,
  maskAddress,
  normalizeAddress,
  normalizeRecipients,
  sanitizeHeaderText,
} from './address.js';
import { isValidMessageId, mandatoryHeaders, type MailOrigin } from './headers.js';
import { guardedSmtpSocket, type HostLookup } from './identities/host-guard.js';
import { SendRateLimiter, systemClock, type Clock, type EmailQuota } from './limits.js';
import {
  EmailSendError,
  refusedRecipients,
  smtpReplyOf,
  smtpSendError,
  type RejectedRecipient,
  type SmtpReply,
} from './smtp-errors.js';
import {
  defaultTransportFactory,
  IdentityTransportCache,
  INSTANCE_TRANSPORT,
  instanceEndpoint,
  maskHost,
  SMTP_TIMEOUTS,
  type MailTransportRef,
  type SmtpEndpoint,
  type TransportFactory,
} from './transport.js';

import type { AppConfig } from '../config/load-config.js';
import type { SmtpSecurity } from '@cellhive/contracts';
import type { Readable } from 'node:stream';
import type { Transporter } from 'nodemailer';

export interface MailAddress {
  readonly address: string;
  /** Display name; CR/LF and control characters are removed. */
  readonly name?: string | null;
}

/**
 * A file attached to an email (BACKLOG T532): the name (control characters
 * removed by the caller; nodemailer encodes it per RFC 2231), the MIME type
 * sniffed at upload and a stream read once while the message is written —
 * never a path or a URL (`disableFileAccess`, `disableUrlAccess`).
 */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Readable;
  /**
   * Content-ID (without `<>`) of an inline image (BACKLOG T534): the part is
   * sent `Content-Disposition: inline` in a `multipart/related` with the
   * HTML, which references it as `cid:<this>`. Absent: a file attachment.
   */
  readonly cid?: string;
}

/**
 * One outgoing email: plain text plus HTML (`multipart/alternative`).
 * Recipients, `from` and `replyTo` are validated one by one here; callers
 * never join strings into headers.
 */
export interface MailMessage {
  readonly to: string | readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Sender resolved by the caller (T530): `SMTP_FROM` (default) or an
   * address in `SMTP_ALLOWED_FROM_DOMAINS` on the instance transport; the
   * identity's own address on an identity transport.
   */
  readonly from?: MailAddress;
  /** Verified identities or Cellhive user emails only (ADR-33). */
  readonly replyTo?: readonly MailAddress[];
  /** Deterministic `<…@…>` from the caller's idempotency key (`deterministicMessageId`). */
  readonly messageId?: string;
  /** Default `system`. */
  readonly origin?: MailOrigin;
  /** Default the instance SMTP. */
  readonly transport?: MailTransportRef;
  /** Files (`multipart/mixed`); their limits are the caller's (T532). */
  readonly attachments?: readonly MailAttachment[];
}

export interface MailSendResult {
  readonly messageId: string;
  /** Masked accepted recipients. */
  readonly accepted: readonly string[];
  /** Masked recipients left out (invalid) or refused by the server while others were accepted. */
  readonly rejected: readonly RejectedRecipient[];
  /** Size of the encoded message, when the transport reports it. */
  readonly bytes: number | null;
  readonly smtp: SmtpReply;
}

/** What may be shown about an SMTP endpoint: no credentials, masked host. */
export interface SmtpDescription {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
}

/**
 * Sends email (SPEC §14.2, §20; BACKLOG T513): the one `send` every source
 * uses — system emails, notifications (T512), automations (T514).
 *
 * Never logs nor puts in errors: addresses (only masked), subjects, bodies,
 * SMTP credentials or the server's reply text.
 */
export interface Mailer {
  /** `true` when `SMTP_URL` is set (identity transports work either way). */
  readonly instanceConfigured: boolean;
  /** Instance SMTP, or `null` when not configured. */
  readonly instance: SmtpDescription | null;
  /** Throws `EmailSendError` when the message is not sent at all. */
  send(message: MailMessage): Promise<MailSendResult>;
  /** Connects and authenticates without sending; throws `EmailSendError`. */
  verify(transport?: MailTransportRef): Promise<void>;
  /** Closes the cached transport of an identity (changed, disabled or deleted; T530). */
  forgetIdentity(identityId: string): void;
  close(): void;
}

export interface CreateMailerOptions {
  /**
   * The nodemailer transport of the instance SMTP instead of `SMTP_URL`
   * (tests). Only consulted when the instance SMTP is configured.
   */
  readonly transport?: Transporter;
  /** Builds identity transports (and the instance one without `transport`). */
  readonly transportFactory?: TransportFactory;
  /**
   * Hourly counter per organization (`EMAIL_MAX_PER_HOUR_PER_ORG`) for
   * `notification`/`automation` messages. Without it those are not counted
   * (processes that only send system email).
   */
  readonly orgQuota?: EmailQuota | null;
  /** Optional hourly counter per sender identity with its own SMTP (T530 hook). */
  readonly identityQuota?: EmailQuota | null;
  /** Per-process rate limiter; default `SMTP_MAX_PER_SEC` of the config. */
  readonly rateLimiter?: SendRateLimiter;
  readonly clock?: Clock;
  /** Most identity transports kept open at once (default 20). */
  readonly maxIdentityTransports?: number;
  /**
   * DNS resolution of identity SMTP hosts, checked on every connection by
   * the SSRF guard (default: the system resolver; tests replace it).
   */
  readonly hostLookup?: HostLookup;
  /** Timeouts of identity transports (default `SMTP_TIMEOUTS`; tests shorten them). */
  readonly identityTimeouts?: Partial<typeof SMTP_TIMEOUTS>;
}

type MailerConfig = Pick<AppConfig, 'mail' | 'email'>;

class SmtpMailer implements Mailer {
  readonly instanceConfigured: boolean;
  readonly instance: SmtpDescription | null;
  private instanceTransport: Transporter | null;
  private readonly identities: IdentityTransportCache;
  private readonly rateLimiter: SendRateLimiter;

  constructor(
    private readonly config: MailerConfig,
    private readonly options: CreateMailerOptions,
  ) {
    const factory = options.transportFactory ?? defaultTransportFactory;
    if (config.mail === null) {
      this.instanceConfigured = false;
      this.instance = null;
      this.instanceTransport = null;
    } else {
      const { endpoint, credentials } = instanceEndpoint(config.mail);
      this.instanceConfigured = true;
      this.instance = describeSmtp(endpoint);
      this.instanceTransport = options.transport ?? factory(endpoint, credentials, { pool: false });
    }
    const timeouts = { ...SMTP_TIMEOUTS, ...options.identityTimeouts };
    // Identity SMTP servers are chosen by organization admins: every
    // connection resolves and checks the host again (SSRF, DNS rebinding).
    this.identities = new IdentityTransportCache(
      factory,
      options.maxIdentityTransports ?? 20,
      (endpoint) => ({
        timeouts,
        getSocket: guardedSmtpSocket(endpoint.host, endpoint.port, {
          allowPrivate: config.email.allowPrivateSmtpHosts,
          connectTimeoutMs: timeouts.connectionTimeout,
          ...(options.hostLookup === undefined ? {} : { lookup: options.hostLookup }),
        }),
      }),
    );
    this.rateLimiter =
      options.rateLimiter ??
      new SendRateLimiter(config.email.maxPerSecond, options.clock ?? systemClock);
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const ref = message.transport ?? INSTANCE_TRANSPORT;
    const origin = message.origin ?? { kind: 'system' };
    const recipients = normalizeRecipients({
      to: typeof message.to === 'string' ? [message.to] : message.to,
      cc: message.cc ?? [],
      bcc: message.bcc ?? [],
    });
    const invalid: RejectedRecipient[] = recipients.invalid.map((masked) => ({
      masked,
      code: 'invalid_address',
      smtp: null,
    }));
    if (recipients.count > this.config.email.maxRecipients) {
      throw new EmailSendError('too_many_recipients', 'The message has too many recipients.', {
        retryable: false,
      });
    }
    if (recipients.count === 0) {
      throw new EmailSendError('invalid_recipients', 'The message has no valid recipient.', {
        retryable: false,
        rejected: invalid,
      });
    }
    if (Buffer.byteLength(message.html, 'utf8') > this.config.email.maxHtmlBytes) {
      throw new EmailSendError('email_body_too_large', 'The HTML part is too large.', {
        retryable: false,
      });
    }
    const from = this.senderOf(ref, message.from);
    const replyTo = (message.replyTo ?? []).map((item) => {
      const address = normalizeAddress(item.address);
      if (address === null) throw invalidSender('A Reply-To address is not valid.');
      return { address, name: sanitizeHeaderText(item.name ?? '') };
    });
    if (message.messageId !== undefined && !isValidMessageId(message.messageId)) {
      throw new TypeError('messageId must look like <id@domain>');
    }
    const headers = mandatoryHeaders(origin);
    const transporter = await this.transporterOf(ref);

    const now = new Date((this.options.clock ?? systemClock).now());
    const counted: { quota: EmailQuota; key: string }[] = [];
    const release = async () => {
      await Promise.allSettled(counted.map(({ quota, key }) => quota.release(key, now)));
    };
    const take = async (quota: EmailQuota | null | undefined, key: string) => {
      if (quota === null || quota === undefined) return;
      const decision = await quota.take(key, now);
      if (!decision.allowed) {
        await release();
        throw new EmailSendError(
          'email_quota_exceeded',
          'The hourly email limit is reached; try again later.',
          { retryable: true, retryAt: decision.retryAt },
        );
      }
      counted.push({ quota, key });
    };
    if (origin.kind !== 'system') await take(this.options.orgQuota, origin.organizationId);
    if (ref.kind === 'identity') await take(this.options.identityQuota, ref.identityId);

    // The slot is held for the whole SMTP transaction (sliding second, S5-review §4 #15).
    const slot = await this.rateLimiter.acquire();
    let info: {
      messageId?: unknown;
      accepted?: unknown;
      rejected?: unknown;
      rejectedErrors?: unknown;
      messageSize?: unknown;
      response?: unknown;
    };
    try {
      info = await transporter.sendMail({
        from: from.name === '' ? from.address : { name: from.name, address: from.address },
        to: [...recipients.to],
        ...(recipients.cc.length === 0 ? {} : { cc: [...recipients.cc] }),
        ...(recipients.bcc.length === 0 ? {} : { bcc: [...recipients.bcc] }),
        ...(replyTo.length === 0
          ? {}
          : {
              replyTo: replyTo.map((item) =>
                item.name === '' ? item.address : { name: item.name, address: item.address },
              ),
            }),
        subject: sanitizeHeaderText(message.subject),
        text: message.text,
        html: message.html,
        headers,
        ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
        ...(message.attachments === undefined || message.attachments.length === 0
          ? {}
          : {
              attachments: message.attachments.map((item) =>
                item.cid === undefined
                  ? {
                      filename: item.filename,
                      contentType: item.contentType,
                      contentDisposition: 'attachment' as const,
                      content: item.content,
                    }
                  : {
                      filename: item.filename,
                      contentType: item.contentType,
                      contentDisposition: 'inline' as const,
                      cid: item.cid,
                      content: item.content,
                    },
              ),
            }),
        // Message parts never reference files or URLs.
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      await slot.release();
      await release();
      throw smtpSendError(error, invalid);
    }
    await slot.release();
    const refused = refusedRecipients(info);
    return {
      messageId: typeof info.messageId === 'string' ? info.messageId : '',
      accepted: (Array.isArray(info.accepted) ? info.accepted : []).map((address: unknown) =>
        maskAddress(typeof address === 'string' ? address : String(address)),
      ),
      rejected: [...invalid, ...refused],
      bytes: typeof info.messageSize === 'number' ? info.messageSize : null,
      smtp: smtpReplyOf(info.response),
    };
  }

  async verify(transport: MailTransportRef = INSTANCE_TRANSPORT): Promise<void> {
    const transporter = await this.transporterOf(transport);
    try {
      await transporter.verify();
    } catch (error) {
      throw smtpSendError(error);
    }
  }

  forgetIdentity(identityId: string): void {
    this.identities.drop(identityId);
  }

  close(): void {
    this.instanceTransport?.close();
    this.instanceTransport = null;
    this.identities.closeAll();
  }

  private async transporterOf(ref: MailTransportRef): Promise<Transporter> {
    if (ref.kind === 'identity') {
      try {
        return await this.identities.get(ref);
      } catch {
        throw new EmailSendError(
          'smtp_temporary',
          'The SMTP credentials of the sender could not be loaded.',
          { retryable: true, reason: 'unknown' },
        );
      }
    }
    if (this.instanceTransport === null) {
      throw new EmailSendError('smtp_not_configured', 'Email is not configured (SMTP_URL).', {
        retryable: false,
      });
    }
    return this.instanceTransport;
  }

  /** `From` allowed for the transport (ADR-33): never anything else. */
  private senderOf(
    ref: MailTransportRef,
    from: MailAddress | undefined,
  ): { address: string; name: string } {
    const mail = this.config.mail;
    if (ref.kind === 'identity') {
      const own = normalizeAddress(ref.fromAddress);
      const address = normalizeAddress(from?.address ?? ref.fromAddress);
      if (own === null || address === null || address.toLowerCase() !== own.toLowerCase()) {
        throw invalidSender('The sender address is not the identity of this SMTP.');
      }
      return { address, name: sanitizeHeaderText(from?.name ?? '') };
    }
    if (mail === null) {
      throw new EmailSendError('smtp_not_configured', 'Email is not configured (SMTP_URL).', {
        retryable: false,
      });
    }
    if (from === undefined) {
      return { address: mail.fromAddress, name: sanitizeHeaderText(mail.fromName ?? '') };
    }
    const address = normalizeAddress(from.address);
    const allowed =
      address !== null &&
      (address.toLowerCase() === mail.fromAddress.toLowerCase() ||
        mail.allowedFromDomains.includes(domainOf(address)));
    if (!allowed) {
      throw invalidSender('The sender address is not allowed on the instance SMTP.');
    }
    return { address, name: sanitizeHeaderText(from.name ?? '') };
  }
}

function invalidSender(message: string): EmailSendError {
  return new EmailSendError('invalid_sender', message, { retryable: false });
}

export function describeSmtp(endpoint: SmtpEndpoint): SmtpDescription {
  return { host: maskHost(endpoint.host), port: endpoint.port, security: endpoint.security };
}

/**
 * The mail service: always present, sends through the instance SMTP when
 * `SMTP_URL` is set and through identity SMTPs passed at send time (T530).
 */
export function createMailService(config: MailerConfig, options: CreateMailerOptions = {}): Mailer {
  return new SmtpMailer(config, options);
}

/**
 * The mailer for `config`, or `null` when `SMTP_URL` is unset (email
 * disabled for system mail, the default: no external service is required).
 */
export function createMailer(
  config: MailerConfig,
  options: CreateMailerOptions = {},
): Mailer | null {
  return config.mail === null ? null : new SmtpMailer(config, options);
}
