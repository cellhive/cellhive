import {
  automationEmailAssetUrl,
  createUploadResponseSchema,
  emailAssetSchema,
  orgEmailAssetUrl,
  type EmailAssetUploadRequest,
} from '@cellhive/contracts';

import { apiRequest } from '../api/client';

/**
 * Where email images are uploaded (CONTRACTS §23.5, T534): signature images
 * of an organization (owners/admins), or body images of one automation (its
 * managers, for the email template editor of T522).
 */
export type EmailImageTarget =
  | { readonly kind: 'org'; readonly orgId: string }
  | { readonly kind: 'automation'; readonly automationId: string };

const id = encodeURIComponent;

function base(target: EmailImageTarget): string {
  return target.kind === 'org'
    ? `/orgs/${id(target.orgId)}/email-assets`
    : `/automations/${id(target.automationId)}/email-assets`;
}

/** Where the editor previews an image (`302` to a signed URL of the viewer, 60 s). */
export function emailImageUrl(target: EmailImageTarget, assetId: string): string {
  return target.kind === 'org'
    ? orgEmailAssetUrl(target.orgId, assetId)
    : automationEmailAssetUrl(target.automationId, assetId);
}

export const emailImagesApi = {
  /** `POST …/email-assets/uploads`: a presigned `PUT` for the image. */
  start: (target: EmailImageTarget, body: EmailAssetUploadRequest, signal?: AbortSignal) =>
    apiRequest(`${base(target)}/uploads`, createUploadResponseSchema, {
      method: 'POST',
      body,
      signal,
    }),
  /** `POST …/email-assets/uploads/:id/complete`: checked, re-encoded without metadata. */
  complete: (target: EmailImageTarget, assetId: string, signal?: AbortSignal) =>
    apiRequest(`${base(target)}/uploads/${id(assetId)}/complete`, emailAssetSchema, {
      method: 'POST',
      signal,
    }),
};
