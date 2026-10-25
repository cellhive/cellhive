import { EMAIL_IDENTITY_SIGNATURE_MAX, EMAIL_SIGNATURE_MAX_IMAGES } from '@cellhive/contracts';
import { Button, cn, Tooltip } from '@cellhive/ui';
import { Bold, Italic, Link, List } from 'lucide-react';
import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { emailImageUrl, type EmailImageTarget } from '../../../../lib/email-images/api';
import {
  InsertImageButton,
  type EmailImageUploader,
} from '../../../../lib/email-images/InsertImageButton';
import { useNumberFormat } from '../../../../lib/i18n/format';
import { Markdown } from '../../../../lib/markdown/Markdown';
import {
  applyFormat,
  insertImage,
  signatureBlocks,
  signatureImageCount,
  signatureIssue,
  signatureLength,
  type SignatureFormat,
  type SignatureIssue,
} from '../model/signature';

import type { TFunction } from 'i18next';

const FORMATS: readonly { format: SignatureFormat; icon: typeof Bold }[] = [
  { format: 'bold', icon: Bold },
  { format: 'italic', icon: Italic },
  { format: 'link', icon: Link },
  { format: 'list', icon: List },
];

export interface SignatureEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Translated error from the server (`errors[]` at `signature_md`). */
  readonly serverError?: string | undefined;
  /**
   * Where "Insert image" uploads signature images (T534: the organization);
   * without it the toolbar has no image button and the preview shows alt texts.
   */
  readonly imageTarget?: EmailImageTarget | undefined;
  /** Replaces the image upload (tests). */
  readonly imageUploader?: EmailImageUploader | undefined;
}

type Range = { start: number; end: number };

/** Selects the pending range of a toolbar edit in the text area (once). */
function applySelection(element: HTMLTextAreaElement, pending: { current: Range | null }): void {
  const range = pending.current;
  if (range === null) return;
  pending.current = null;
  element.focus();
  element.setSelectionRange(range.start, range.end);
}

function issueMessage(
  issue: SignatureIssue,
  t: TFunction<'emailIdentities'>,
  number: (value: number) => string,
): string {
  switch (issue.code) {
    case 'TOO_BIG':
      return t('signature.tooBig', { maximum: number(issue.maximum) });
    case 'PLACEHOLDER_NOT_ALLOWED':
      return t('signature.placeholder');
    case 'IMAGE_SOURCE_NOT_ALLOWED':
      return t('signature.imageSource');
    case 'TOO_MANY_IMAGES':
      return t('signature.tooManyImages', { count: issue.maximum });
  }
}

/**
 * Signature of an identity or of the organization (ADR-33 §3, CONTRACTS
 * §23.4): narrow Markdown with a toolbar that inserts syntax (never HTML) —
 * "Insert image" uploads a logo (T534, at most 2, embedded as `cid:` parts
 * in emails) — a counter against the 2,000 characters, the server's rules
 * checked as you type (no `{{`, no image links), and a preview of what the
 * email shows (images through the viewer's short-lived URLs).
 */
export function SignatureEditor({
  value,
  onChange,
  serverError,
  imageTarget,
  imageUploader,
}: SignatureEditorProps) {
  const { t } = useTranslation('emailIdentities');
  const number = useNumberFormat();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const issue = signatureIssue(value);
  const blocks = useMemo(() => signatureBlocks(value), [value]);
  const length = signatureLength(value);
  const images = useMemo(() => signatureImageCount(value), [value]);
  const error = issue === null ? serverError : issueMessage(issue, t, number);
  // Where the caret last was in the text area: an image goes there (else at the end).
  const caret = useRef<{ start: number; end: number } | null>(null);
  // The selection a toolbar edit leaves (the inserted sample text, e.g. the
  // `https://` of a link): set in the same commit as the new value, before the
  // browser handles the next key — a selection set a frame later lands after
  // the first typed characters, which then end up outside the link (T527).
  const select = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    if (area.current !== null) applySelection(area.current, select);
  }, [value]);
  const insert = (markdown: string) => {
    const element = area.current;
    const at = caret.current;
    const start = Math.min(at?.start ?? value.length, value.length);
    const end = Math.min(at?.end ?? value.length, value.length);
    const edit = insertImage(value, start, end, markdown);
    caret.current = { start: edit.selectionStart, end: edit.selectionEnd };
    select.current = { start: edit.selectionStart, end: edit.selectionEnd };
    if (element !== null && edit.value === value) applySelection(element, select);
    onChange(edit.value);
  };
  const format = (kind: SignatureFormat) => {
    const element = area.current;
    if (element === null) return;
    const edit = applyFormat(
      value,
      element.selectionStart,
      element.selectionEnd,
      kind,
      t(`signature.sample.${kind}`),
    );
    select.current = { start: edit.selectionStart, end: edit.selectionEnd };
    if (edit.value === value) applySelection(element, select);
    onChange(edit.value);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-label text-fg">
        {t('form.signature')}
      </label>
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-md border border-line-control bg-surface focus-within:outline-2 focus-within:outline-accent',
          error !== undefined && 'border-danger',
        )}
      >
        <div
          role="toolbar"
          aria-label={t('signature.toolbar')}
          aria-controls={id}
          className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface-sunken px-1 py-0.5"
        >
          {FORMATS.map(({ format: kind, icon: Icon }) => (
            <Tooltip key={kind} content={t(`signature.format.${kind}`)}>
              <Button
                variant="ghost"
                size="toolbar"
                aria-label={t(`signature.format.${kind}`)}
                onMouseDown={(event) => {
                  // Keep the selection of the text area.
                  event.preventDefault();
                }}
                onClick={() => {
                  format(kind);
                }}
              >
                <Icon aria-hidden="true" />
              </Button>
            </Tooltip>
          ))}
          {imageTarget === undefined ? null : (
            <InsertImageButton
              target={imageTarget}
              uploader={imageUploader}
              disabledReason={
                images >= EMAIL_SIGNATURE_MAX_IMAGES
                  ? t('signature.tooManyImages', { count: EMAIL_SIGNATURE_MAX_IMAGES })
                  : undefined
              }
              onInsert={(asset) => {
                insert(asset.markdown);
              }}
            />
          )}
        </div>
        <textarea
          ref={area}
          id={id}
          value={value}
          rows={4}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-help ${id}-count${error === undefined ? '' : ` ${id}-error`}`}
          className="min-h-24 resize-y bg-surface px-3 py-2 font-mono text-mono text-fg outline-none max-lg:text-[16px]"
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onSelect={(event) => {
            const { selectionStart, selectionEnd } = event.currentTarget;
            caret.current = { start: selectionStart, end: selectionEnd };
          }}
        />
      </div>
      <div className="flex items-start justify-between gap-3 text-label font-normal text-fg-muted">
        <span id={`${id}-help`}>{t('signature.help')}</span>
        <span
          id={`${id}-count`}
          className={cn(
            'shrink-0 tabular-nums',
            length > EMAIL_IDENTITY_SIGNATURE_MAX && 'text-danger',
          )}
        >
          {t('signature.count', {
            length: number(length),
            maximum: number(EMAIL_IDENTITY_SIGNATURE_MAX),
          })}
        </span>
      </div>
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-label font-normal text-danger">
          {error}
        </p>
      )}
      {blocks.length === 0 ? null : (
        <section
          aria-label={t('signature.preview')}
          data-testid="signature-preview"
          className="flex flex-col gap-1 rounded-md border border-line bg-surface-sunken px-3 py-2"
        >
          <span className="text-label text-fg-muted">{t('signature.preview')}</span>
          <Markdown
            blocks={blocks}
            className="text-body text-fg"
            imageUrl={
              imageTarget === undefined
                ? undefined
                : (node) => (node.source === 'asset' ? emailImageUrl(imageTarget, node.id) : null)
            }
          />
        </section>
      )}
    </div>
  );
}
