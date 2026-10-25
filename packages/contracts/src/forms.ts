import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/**
 * Form submissions (SPEC §8, §15A; CONTRACTS §17; BACKLOG T306): members of
 * the base submit through `POST /views/{viewId}/submit`, anyone holding a
 * form link through `POST /shares/{token}/submit`. Both create exactly one
 * record through the record mutation service and answer with the form's
 * closing settings only, never the record.
 */

/**
 * How often one person may submit a form (BACKLOG S3 decision 9), counted
 * in the base's time zone: `once` ever, or once per calendar day, ISO week
 * (Monday–Sunday) or month. Only forms that require sign-in can have a limit.
 */
export const SUBMISSION_LIMITS = ['none', 'once', 'daily', 'weekly', 'monthly'] as const;
export const submissionLimitSchema = z.enum(SUBMISSION_LIMITS).meta({
  id: 'SubmissionLimit',
  description:
    'Submissions per signed-in person: `none`, `once`, or one per calendar `daily` / ' +
    '`weekly` (ISO week) / `monthly` period in the base time zone. Needs `require_login`.',
});
export type SubmissionLimit = z.infer<typeof submissionLimitSchema>;

/** Most field values in one submission (a form lists at most 500 fields). */
export const MAX_FORM_SUBMISSION_FIELDS = 500;
/** Largest submission body, in bytes of JSON (smaller than the generic 10 MiB limit). */
export const MAX_FORM_SUBMISSION_BYTES = 256 * 1024;
/** Longest `submit_token` accepted. */
export const MAX_SUBMIT_TOKEN_LENGTH = 512;
/** Submissions per minute per client IP through a link (per user for members), BACKLOG S3 #5. */
export const FORM_SUBMISSIONS_PER_MINUTE = 10;
/** Shortest time between fetching a submit token and submitting with it. */
export const DEFAULT_FORM_MIN_FILL_SECONDS = 3;
/** A submit token is valid this long after it was issued. */
export const FORM_SUBMIT_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Detail code (`VALIDATION_FAILED`, path `submit_token`): missing, forged, expired, for another link or used. */
export const SUBMIT_TOKEN_INVALID = 'SUBMIT_TOKEN_INVALID';
/** Detail code (`VALIDATION_FAILED`, path `submit_token`): submitted sooner than the minimum fill time (`params.retry_after_ms`). */
export const SUBMITTED_TOO_FAST = 'SUBMITTED_TOO_FAST';
/** Detail code (`VALIDATION_FAILED`, view config): a submission limit needs `require_login = true`. */
export const REQUIRES_LOGIN = 'REQUIRES_LOGIN';
/** Detail code of `409 SUBMISSION_LIMIT_REACHED` (`params.limit`, `params.next_allowed_at`). */
export const SUBMISSION_LIMIT_REACHED = 'SUBMISSION_LIMIT_REACHED';
/**
 * Detail code of `403 SHARE_PASSWORD_REQUIRED`: a link with a password needs
 * its unlock cookie (CONTRACTS §16A, T305).
 */
export const UNLOCK_REQUIRED = 'UNLOCK_REQUIRED';

export const formSubmitRequestSchema = z
  .strictObject({
    fields: z
      .record(idOf('fld'), z.unknown())
      .refine((value) => Object.keys(value).length <= MAX_FORM_SUBMISSION_FIELDS, {
        message: `At most ${String(MAX_FORM_SUBMISSION_FIELDS)} fields`,
      })
      .default({})
      .meta({
        description:
          'Values keyed by field id; only fields of the form. Always typecast with the base ' +
          'locale (CONTRACTS §2), so values from URL prefill (`?prefill_<field_id>=…`) can be ' +
          'sent as strings; select options are never created. Hidden prefilled fields are sent ' +
          'here too and validated like the others.',
      }),
    submit_token: z
      .string()
      .max(MAX_SUBMIT_TOKEN_LENGTH)
      .optional()
      .meta({
        description:
          'From `GET /shares/{token}/submit-token`; required on the link route, ignored on the ' +
          'member route. Single use; at least the minimum fill time old.',
      }),
    honeypot: z
      .string()
      .max(1000)
      .optional()
      .meta({
        description:
          'Must be empty or absent: the value of a field hidden from people. A non-empty value ' +
          'gets the normal success response and nothing is written.',
      }),
  })
  .meta({ id: 'FormSubmitRequest' });
export type FormSubmitRequest = z.infer<typeof formSubmitRequestSchema>;

export const formSubmitResponseSchema = z
  .object({
    success_message: z.string().meta({ description: 'Message to show; may be empty' }),
    redirect_url: z
      .string()
      .nullable()
      .meta({ description: 'Absolute `http(s)` URL to open after the submission, or `null`' }),
  })
  .meta({ id: 'FormSubmitResponse', description: 'Never contains the record.' });
export type FormSubmitResponse = z.infer<typeof formSubmitResponseSchema>;

export const formSubmitTokenSchema = z
  .object({
    submit_token: z.string(),
    not_before: isoDateTimeSchema.meta({
      description: 'Submitting with the token earlier is `SUBMITTED_TOO_FAST`',
    }),
    expires_at: isoDateTimeSchema,
  })
  .meta({ id: 'FormSubmitToken' });
export type FormSubmitTokenDto = z.infer<typeof formSubmitTokenSchema>;

/**
 * `GET /views/:viewId/submission-status` (T320): whether the signed-in
 * member already reached the form's `submission_limit` in the current
 * period, so the form can say so when it opens instead of after filling it.
 */
export const formSubmissionStatusSchema = z
  .object({
    limit: submissionLimitSchema,
    reached: z.boolean().meta({
      description:
        'Submitting now would be `409 SUBMISSION_LIMIT_REACHED`; always `false` for `none`',
    }),
    next_allowed_at: isoDateTimeSchema.nullable().meta({
      description:
        'When the next period starts (`reached` only); `null` for `once` or when not reached',
    }),
  })
  .meta({ id: 'FormSubmissionStatus' });
export type FormSubmissionStatus = z.infer<typeof formSubmissionStatusSchema>;

/**
 * A person a `user` question of a form link offers (T321): only `org` links
 * list them, and never with an email (CONTRACTS §16A, §17).
 */
export const shareFormMemberSchema = z
  .object({ id: idOf('usr'), display_name: z.string() })
  .meta({ id: 'ShareFormMember' });
export type ShareFormMemberDto = z.infer<typeof shareFormMemberSchema>;

/**
 * `GET /shares/:token/members` (T321): the active members of the
 * organization who can open the form's base, for the `user` questions of an
 * `org` form link; oldest member first, not paged.
 */
export const shareFormMemberListSchema = z
  .object({ items: z.array(shareFormMemberSchema) })
  .meta({ id: 'ShareFormMemberList' });
export type ShareFormMemberList = z.infer<typeof shareFormMemberListSchema>;

// --- Link and attachment questions of form links (T410) ------------------------------

/**
 * Records a link question of an `org` form link offers (T410, BACKLOG S4
 * open question #4): `GET /shares/:token/link-candidates/:fieldId`. Links
 * outside the organization never ask link questions (they are hidden like
 * `user` questions, T321).
 */
export const DEFAULT_SHARE_LINK_CANDIDATE_LIMIT = 20;
export const MAX_SHARE_LINK_CANDIDATE_LIMIT = 50;
/** Longest `search` of a form link picker, in characters. */
export const MAX_SHARE_LINK_CANDIDATE_SEARCH_LENGTH = 200;

/**
 * Anonymous uploads of attachment questions through a form link (T410,
 * BACKLOG S4 open question #14): per client IP, files per question, bytes
 * per submission (submit token). Files never submitted are deleted after
 * 24 hours (`ATTACHMENT_UNATTACHED_TTL_HOURS`).
 */
export const SHARE_FORM_UPLOAD_RATE_LIMIT = 20;
export const SHARE_FORM_UPLOAD_RATE_WINDOW_SECONDS = 600;
/** Files per question and bytes per submission (defined apart from the schemas). */
export {
  SHARE_FORM_MAX_FILES_PER_QUESTION,
  SHARE_FORM_MAX_UPLOAD_BYTES,
} from './client-constants.js';
/** Detail code (`VALIDATION_FAILED`): the uploads of one submission exceed `params.limit` bytes. */
export const UPLOAD_LIMIT_EXCEEDED = 'UPLOAD_LIMIT_EXCEEDED';

/** Route parameter of the public share endpoints (`/shares/{token}/…`). */
export const shareTokenParamSchema = z
  .string()
  .max(128)
  .meta({ description: 'Share link token (43 characters of base64url)' });
