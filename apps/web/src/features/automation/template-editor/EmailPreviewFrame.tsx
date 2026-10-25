import { cn } from '@cellhive/ui';
import { useMemo } from 'react';

import stylesheetUrl from './email-preview-frame.css?url';
import { previewDocument, type PreviewImage } from './preview-document';

export interface EmailPreviewFrameProps {
  /** The whole HTML document the server rendered (CONTRACTS §21 `email-preview`). */
  readonly html: string;
  /** Inline images: `cid:` sources shown through these signed URLs (T534). */
  readonly images?: readonly PreviewImage[];
  /** Accessible name of the frame. */
  readonly title: string;
  readonly className?: string;
}

/**
 * The email in a sandboxed frame (ADR-32 §3; BACKLOG T522): `srcdoc`, an
 * empty `sandbox` (no scripts, opaque origin, no forms, no popups, no top
 * navigation), its own CSP; values of the record show as text because the
 * server never let them through the Markdown parser.
 */
export function EmailPreviewFrame({ html, images, title, className }: EmailPreviewFrameProps) {
  const srcDoc = useMemo(
    () =>
      previewDocument(html, {
        stylesheet: new URL(stylesheetUrl, window.location.href).href,
        images: images ?? [],
      }),
    [html, images],
  );
  return (
    <iframe
      sandbox=""
      srcDoc={srcDoc}
      title={title}
      referrerPolicy="no-referrer"
      data-testid="email-preview-frame"
      className={cn('block w-full border-0 bg-surface-sunken', className)}
    />
  );
}
