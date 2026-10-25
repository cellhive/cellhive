import {
  MAX_AUTOMATION_NAME_LENGTH,
  type AutomationDefinition,
  type Id,
} from '@cellhive/contracts';
import { collectImages, IMAGE_SOURCES, parseTemplate } from '@cellhive/markdown';

import { sendEmailSteps } from '../actions/send-email/sender-check.js';

/**
 * Duplicating an automation (BACKLOG T551, CONTRACTS §21) — the pure parts:
 * the default name of the copy, the body images (`asset:att_…`) of its
 * `send_email` steps, and the definition with those images replaced by
 * their copies. Permission checks, the copy of the images and the save are
 * the caller's (the API's automation service).
 */

/** Suffix of the default name of a copy, by language (`vi` or else `en`). */
export const DUPLICATE_NAME_SUFFIXES = { en: ' (copy)', vi: ' (bản sao)' } as const;

/** `vi` for a Vietnamese locale (`vi`, `vi-VN`…), `en` otherwise. */
function languageOf(locale: string | null | undefined): keyof typeof DUPLICATE_NAME_SUFFIXES {
  return typeof locale === 'string' && /^vi(?:[-_]|$)/iu.test(locale) ? 'vi' : 'en';
}

/**
 * "«name» (copy)" / "«name» (bản sao)" in the caller's language. The source
 * name is cut (whole characters, trailing spaces dropped) so the result
 * stays within `MAX_AUTOMATION_NAME_LENGTH` UTF-16 units, the limit of the
 * name schema.
 */
export function duplicateAutomationName(name: string, locale: string | null | undefined): string {
  const suffix = DUPLICATE_NAME_SUFFIXES[languageOf(locale)];
  const room = MAX_AUTOMATION_NAME_LENGTH - suffix.length;
  let kept = '';
  for (const char of name.trim()) {
    if (kept.length + char.length > room) break;
    kept += char;
  }
  return `${kept.trimEnd()}${suffix}`;
}

/** A body image of a `send_email` step and where it is (`errors[].path`). */
export interface EmailAssetReference {
  readonly assetId: Id<'att'>;
  /** `definition.actions[n]….config.body.template`. */
  readonly path: string;
}

/**
 * Every `asset:att_…` body image of the definition's `send_email` steps
 * (inside `if` branches too), once per step, in order — the images the
 * save check (`checkSendEmailImages`) requires to be this automation's.
 */
export function emailAssetReferencesOf(definition: AutomationDefinition): EmailAssetReference[] {
  const references: EmailAssetReference[] = [];
  for (const { action, path } of sendEmailSteps(definition)) {
    const images = collectImages(
      parseTemplate(action.config.body.template, { images: IMAGE_SOURCES }).blocks,
    );
    const seen = new Set<string>();
    for (const image of images) {
      if (image.source !== 'asset' || seen.has(image.id)) continue;
      seen.add(image.id);
      references.push({ assetId: image.id as Id<'att'>, path: `${path}.config.body.template` });
    }
  }
  return references;
}

/** `asset:` followed by an attachment id (ids are 16 characters: no prefix of another id). */
const ASSET_TARGET = /asset:(att_[0-9A-Za-z]{16})(?![0-9A-Za-z])/gu;

function replaceIn(value: unknown, mapping: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(ASSET_TARGET, (whole, id: string) => {
      const copy = mapping.get(id);
      return copy === undefined ? whole : `asset:${copy}`;
    });
  }
  if (Array.isArray(value)) return value.map((item) => replaceIn(item, mapping));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceIn(item, mapping)]),
    );
  }
  return value;
}

/**
 * The definition with every `asset:<source id>` of `mapping` replaced by
 * `asset:<copy id>` — in every string of the definition, so nothing can
 * still name a source image (the cleanup keeps an automation asset only
 * while its own automation names it). Other ids and the rest of the
 * definition are kept as they are; the input is not changed.
 */
export function replaceEmailAssetIds(
  definition: AutomationDefinition,
  mapping: ReadonlyMap<Id<'att'>, Id<'att'>>,
): AutomationDefinition {
  if (mapping.size === 0) return definition;
  return replaceIn(definition, mapping) as AutomationDefinition;
}
