import { z } from 'zod';

import { createUploadRequestSchema } from './attachments.js';
import {
  DEFAULT_SHARE_LINK_CANDIDATE_LIMIT,
  MAX_SHARE_LINK_CANDIDATE_LIMIT,
  MAX_SHARE_LINK_CANDIDATE_SEARCH_LENGTH,
  MAX_SUBMIT_TOKEN_LENGTH,
} from './forms.js';
import { idOf } from './ids.js';

/**
 * Inputs of `link` and `attachment` questions of form links (CONTRACTS §17,
 * BACKLOG T410): the picker of `org` form links and anonymous uploads bound
 * to a submit token. Limits and detail codes are in `forms.ts`; the schemas
 * live apart so that pages which never ask such questions (the first load
 * of the share page) do not carry them.
 */

export const shareLinkCandidatesQuerySchema = z
  .object({
    search: z
      .string()
      .max(MAX_SHARE_LINK_CANDIDATE_SEARCH_LENGTH)
      .optional()
      .meta({ description: 'Unaccented, case-insensitive substring of the title' }),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_SHARE_LINK_CANDIDATE_LIMIT)
      .default(DEFAULT_SHARE_LINK_CANDIDATE_LIMIT),
  })
  .meta({ id: 'ShareLinkCandidatesQuery' });
export type ShareLinkCandidatesQuery = z.output<typeof shareLinkCandidatesQuerySchema>;

/** One record a link question of a form link offers: id and title only, no other field. */
export const shareLinkCandidateSchema = z
  .strictObject({
    id: idOf('rec'),
    title: z.string().nullable().meta({
      description:
        'Primary field as text under the link creator’s access; `null` when they cannot read it',
    }),
  })
  .meta({ id: 'ShareLinkCandidate' });
export type ShareLinkCandidateDto = z.infer<typeof shareLinkCandidateSchema>;

export const shareLinkCandidatesSchema = z
  .strictObject({
    items: z.array(shareLinkCandidateSchema),
    offset: z.int().min(0),
    limit: z.int().min(1),
    has_more: z.boolean(),
  })
  .meta({ id: 'ShareLinkCandidates' });
export type ShareLinkCandidatesDto = z.infer<typeof shareLinkCandidatesSchema>;

const submitTokenField = z
  .string()
  .max(MAX_SUBMIT_TOKEN_LENGTH)
  .optional()
  .meta({
    description:
      'Required: the submit token the form will be sent with (`GET /shares/{token}/submit-token`), ' +
      'not used yet (missing, forged, expired, of another link or used → `422 ' +
      'SUBMIT_TOKEN_INVALID`); the minimum fill time does not apply to uploads',
  });

/** `POST /shares/:token/uploads`: like `POST /files/uploads` without `table_id`. */
export const shareFormUploadRequestSchema = createUploadRequestSchema
  .omit({ table_id: true })
  .extend({ submit_token: submitTokenField })
  .meta({ id: 'ShareFormUploadRequest' });
export type ShareFormUploadRequest = z.infer<typeof shareFormUploadRequestSchema>;

/** `POST /shares/:token/uploads/:attachmentId/complete`. */
export const shareFormUploadCompleteRequestSchema = z
  .strictObject({ submit_token: submitTokenField })
  .meta({ id: 'ShareFormUploadCompleteRequest' });
export type ShareFormUploadCompleteRequest = z.infer<typeof shareFormUploadCompleteRequestSchema>;

/**
 * A finished form link upload: sent as `[{ "id" }]` in the attachment
 * question's value. No URL: the person who uploaded it cannot download it.
 */
export const shareFormUploadSchema = z
  .strictObject({
    id: idOf('att'),
    name: z.string(),
    size: z.int().min(0),
    mime: z.string(),
  })
  .meta({ id: 'ShareFormUpload' });
export type ShareFormUploadDto = z.infer<typeof shareFormUploadSchema>;
