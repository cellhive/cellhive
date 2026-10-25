import {
  EMAIL_IMAGE_NOT_FOUND,
  TOO_MANY_IMAGES,
  type AutomationDefinition,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import { collectImages, IMAGE_SOURCES, parseTemplate } from '@cellhive/markdown';

import { sendEmailSteps } from './sender-check.js';

import type { OrgScope } from '../../../db/repository.js';
import type { EmailAssetsRepository } from '../../../mail/images/email-assets.repository.js';

/**
 * Save-time checks of `send_email` body images that need the database
 * (BACKLOG T534) — image syntax and field images are checked by
 * `validateAutomationDefinition`:
 * - every `asset:att_…` must be a ready email asset uploaded for **this**
 *   automation (`EMAIL_IMAGE_NOT_FOUND`, `params.asset_id`: missing,
 *   another automation's or organization's, a signature image, not
 *   uploaded yet — one code, no existence leak). A new automation has no
 *   assets yet: images are added once it exists;
 * - images of the body (each asset and each field once) at most
 *   `EMAIL_MAX_INLINE_IMAGES` (`TOO_MANY_IMAGES`; a field may still hold
 *   more images at run time — the step then fails on the limit).
 * Problems carry the path of the body template under `definition.`.
 */
export async function checkSendEmailImages(
  deps: { readonly assets: Pick<EmailAssetsRepository, 'getReady'> },
  scope: OrgScope,
  input: {
    readonly automationId: Id<'aut'> | null;
    readonly definition: AutomationDefinition;
    readonly maxInlineImages: number;
  },
): Promise<ProblemErrorItem[]> {
  const errors: ProblemErrorItem[] = [];
  for (const { action, path } of sendEmailSteps(input.definition)) {
    const at = `${path}.config.body.template`;
    const images = collectImages(
      parseTemplate(action.config.body.template, { images: IMAGE_SOURCES }).blocks,
    );
    const assetIds = [
      ...new Set(images.filter((image) => image.source === 'asset').map((image) => image.id)),
    ];
    const fieldCount = new Set(
      images.filter((image) => image.source === 'field').map((image) => image.id),
    ).size;
    const count = assetIds.length + fieldCount;
    if (count > input.maxInlineImages) {
      errors.push({
        path: at,
        code: TOO_MANY_IMAGES,
        message: `An email has at most ${String(input.maxInlineImages)} images`,
        params: { count, maximum: input.maxInlineImages },
      });
    }
    if (assetIds.length === 0) continue;
    const found = new Set(
      input.automationId === null
        ? []
        : (await deps.assets.getReady(scope, assetIds))
            .filter((row) => row.kind === 'automation' && row.automation_id === input.automationId)
            .map((row) => row.id as string),
    );
    for (const id of assetIds) {
      if (found.has(id)) continue;
      errors.push({
        path: at,
        code: EMAIL_IMAGE_NOT_FOUND,
        message: 'This image is not an image uploaded for this automation',
        params: { asset_id: id },
      });
    }
  }
  return errors;
}
