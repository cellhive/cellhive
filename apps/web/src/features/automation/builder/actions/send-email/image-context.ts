import { createContext } from 'react';

import type {
  EmailImageField,
  EmailImageUploader,
} from '../../../../../lib/email-images/InsertImageButton';

/** What "Insert image" of the `send_email` body needs from the editor (T534). */
export interface EmailImageOptions {
  /** The saved automation the images belong to (`null` until it is created). */
  readonly automationId: string | null;
  /** Attachment fields of the trigger record whose images the body may show. */
  readonly fields: readonly EmailImageField[];
  /** Images the body already has, and the most one email may have. */
  readonly count: number;
  readonly max: number;
  readonly uploader?: EmailImageUploader | undefined;
}

/** Provided by `SendEmailEditor` around the body editor; no button without it. */
export const EmailImageContext = createContext<EmailImageOptions | null>(null);
