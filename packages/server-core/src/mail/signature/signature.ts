import {
  EMAIL_IMAGE_NOT_FOUND,
  EMAIL_SIGNATURE_MAX_CHARS,
  EMAIL_SIGNATURE_MAX_IMAGES,
  IMAGE_SOURCE_NOT_ALLOWED,
  TOO_MANY_IMAGES,
} from '@cellhive/contracts';
import {
  collectImages,
  imageSyntaxIssues,
  parseMarkdown,
  type Block,
  type ImageSource,
  type Inline,
} from '@cellhive/markdown';

import { AppError } from '../../errors/app-error.js';

import type { OrgScope } from '../../db/repository.js';
import type { EmailAssetsRepository } from '../images/email-assets.repository.js';

/**
 * Signatures of automation emails (ADR-33 §3, BACKLOG T531): the signature
 * of the sender identity (`email_identities.signature_md`) or, for the
 * system sender, the organization's default
 * (`organizations.settings.email.default_signature_md`). Narrow Markdown of
 * `packages/markdown`, at most 2,000 characters, **no placeholders** (static
 * text — no second template context) and at most two **images** (T534: a
 * logo) — `![alt](asset:att_…)`, signature assets uploaded by the
 * organization's owners/admins, sent as inline `cid:` parts. Any other
 * image syntax (a URL, `data:`) is refused when saved; one stored before is
 * rendered as its alternative text only (no link to the remote image).
 *
 * Signatures and footers are for automation emails only; notification and
 * system emails keep their fixed templates.
 */

/** The image sources a signature may use: uploaded signature assets only. */
export const SIGNATURE_IMAGE_SOURCES: readonly ImageSource[] = ['asset'];

export type SignatureIssueCode =
  'TOO_BIG' | 'PLACEHOLDER_NOT_ALLOWED' | typeof IMAGE_SOURCE_NOT_ALLOWED | typeof TOO_MANY_IMAGES;

export interface SignatureIssue {
  readonly code: SignatureIssueCode;
  readonly message: string;
  readonly params: Readonly<Record<string, number>>;
}

/** Characters (code points) of `value`. */
function lengthOf(value: string): number {
  return Array.from(value).length;
}

/**
 * Why `source` may not be saved as a signature, or `null`. `{{` anywhere
 * (even escaped or in code) is refused: a signature is never a template.
 */
export function checkSignature(source: string): SignatureIssue | null {
  const length = lengthOf(source);
  if (length > EMAIL_SIGNATURE_MAX_CHARS) {
    return {
      code: 'TOO_BIG',
      message: `A signature has at most ${String(EMAIL_SIGNATURE_MAX_CHARS)} characters.`,
      params: { maximum: EMAIL_SIGNATURE_MAX_CHARS, length },
    };
  }
  const position = source.indexOf('{{');
  if (position >= 0) {
    return {
      code: 'PLACEHOLDER_NOT_ALLOWED',
      message: 'A signature is fixed text: it cannot contain placeholders ({{ … }}).',
      params: { position },
    };
  }
  const [unsupported] = imageSyntaxIssues(source, SIGNATURE_IMAGE_SOURCES);
  if (unsupported !== undefined) {
    return {
      code: IMAGE_SOURCE_NOT_ALLOWED,
      message: 'A signature image must be an image uploaded for signatures (no URL or data:).',
      params: { position: unsupported.start },
    };
  }
  const images = collectImages(parseMarkdown(source, { images: SIGNATURE_IMAGE_SOURCES }));
  if (images.length > EMAIL_SIGNATURE_MAX_IMAGES) {
    return {
      code: TOO_MANY_IMAGES,
      message: `A signature has at most ${String(EMAIL_SIGNATURE_MAX_IMAGES)} images.`,
      params: { maximum: EMAIL_SIGNATURE_MAX_IMAGES, count: images.length },
    };
  }
  return null;
}

/**
 * A signature as stored, for the save paths (organization default, sender
 * identity): `null` when blank; `422 VALIDATION_FAILED` at `path` with the
 * `checkSignature` code otherwise refused.
 */
export function signatureInput(value: string | null, path: string): string | null {
  if (value === null || value.trim() === '') return null;
  const issue = checkSignature(value);
  if (issue !== null) {
    throw new AppError('VALIDATION_FAILED', {
      detail: issue.message,
      errors: [{ path, code: issue.code, message: issue.message, params: issue.params }],
    });
  }
  return value;
}

/** The asset ids of a signature's images (`asset:att_…`), in order, once each. */
export function signatureAssetIds(source: string | null | undefined): string[] {
  if (source === null || source === undefined || source.trim() === '') return [];
  const images = collectImages(parseMarkdown(source, { images: SIGNATURE_IMAGE_SOURCES }));
  return [...new Set(images.map((image) => image.id))];
}

/**
 * The images of a signature being saved (after `signatureInput`) must be
 * ready signature assets of the organization: else `422 VALIDATION_FAILED`
 * / `EMAIL_IMAGE_NOT_FOUND` at `path` (`params.asset_id`) — missing, of
 * another organization, an automation's image or not uploaded yet are the
 * same code (no existence leak).
 */
export async function checkSignatureAssets(
  assets: Pick<EmailAssetsRepository, 'getReady'>,
  scope: OrgScope,
  source: string | null,
  path: string,
): Promise<void> {
  const ids = signatureAssetIds(source);
  if (ids.length === 0) return;
  const found = new Set(
    (await assets.getReady(scope, ids))
      .filter((row) => row.kind === 'signature')
      .map((row) => row.id as string),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length === 0) return;
  const message = 'This image is not an image uploaded for signatures of this organization.';
  throw new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: missing.map((id) => ({
      path,
      code: EMAIL_IMAGE_NOT_FOUND,
      message,
      params: { asset_id: id },
    })),
  });
}

/**
 * Inline nodes with image syntax that is not an image (`!` right before a
 * link, e.g. a remote URL saved before T534) replaced by the link text: the
 * `!` and the target disappear, the alternative text stays. `image` nodes
 * (signature assets) are kept.
 */
function withoutImages(nodes: readonly Inline[]): Inline[] {
  const result: Inline[] = [];
  for (const node of nodes) {
    const previous = result.at(-1);
    if (node.type === 'link' && previous?.type === 'text' && previous.text.endsWith('!')) {
      const rest = previous.text.slice(0, -1);
      result.pop();
      if (rest !== '') result.push({ type: 'text', text: rest });
      result.push(...withoutImages(node.children));
      continue;
    }
    switch (node.type) {
      case 'strong':
      case 'em':
      case 'del':
        result.push({ type: node.type, children: withoutImages(node.children) });
        break;
      case 'link':
        result.push({ type: 'link', href: node.href, children: withoutImages(node.children) });
        break;
      default:
        result.push(node);
    }
  }
  return result;
}

function blockWithoutImages(block: Block): Block {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', children: withoutImages(block.children) };
    case 'heading':
      return { type: 'heading', level: block.level, children: withoutImages(block.children) };
    case 'list':
      return { type: 'list', ordered: block.ordered, items: block.items.map(withoutImages) };
    case 'blockquote':
      return { type: 'blockquote', children: block.children.map(blockWithoutImages) };
    case 'table':
      return {
        type: 'table',
        align: block.align,
        head: block.head.map(withoutImages),
        rows: block.rows.map((row) => row.map(withoutImages)),
      };
    case 'code_block':
    case 'hr':
      return block;
  }
}

/**
 * The signature as a document tree; `[]` for `null`/blank. Parsed as a
 * plain document (`parseMarkdown`, not `parseTemplate`): a `{{` stored
 * before validation existed stays text, it is never evaluated. Signature
 * assets are `image` nodes (T534).
 */
export function signatureBlocks(source: string | null | undefined): Block[] {
  if (source === null || source === undefined || source.trim() === '') return [];
  return parseMarkdown(source, { images: SIGNATURE_IMAGE_SOURCES }).map(blockWithoutImages);
}
