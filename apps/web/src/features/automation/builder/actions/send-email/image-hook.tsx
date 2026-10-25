import { useContext } from 'react';
import { useTranslation } from 'react-i18next';

import { InsertImageButton } from '../../../../../lib/email-images/InsertImageButton';

import { EmailImageContext } from './image-context';
import { assetImageText, fieldImageText } from './images';

import type { ImageButtonProps } from '../../../template-editor/MarkdownTemplateEditor';

/**
 * "Insert image" of the `send_email` body (T534 in the editor of T522),
 * the `ImageButton` of `MarkdownTemplateEditor`: uploads an image for
 * **this** automation (`![name](asset:att_… =w)`) or inserts the images of
 * an attachment field of the trigger record (`![field name](field:fld_…)`).
 * Emails embed them as inline `cid:` parts; the preview shows them through
 * signed URLs of the viewer. The automation, the fields and the count come
 * from `EmailImageContext`. A new automation has nothing to upload to yet,
 * and an email has at most `max` images: the button says why it is off.
 */
export function EmailImageButton({ onInsert, tabIndex, toolId }: ImageButtonProps) {
  const { t } = useTranslation('automationEmail');
  const options = useContext(EmailImageContext);
  if (options === null) return null;
  const { automationId, fields, count, max, uploader } = options;
  const disabledReason =
    automationId === null
      ? t('body.imageNeedsSave')
      : count >= max
        ? t('body.tooManyImages', { count: max })
        : undefined;
  return (
    <InsertImageButton
      target={{ kind: 'automation', automationId: automationId ?? '' }}
      fields={fields}
      onInsert={(asset) => {
        onInsert(assetImageText(asset));
      }}
      onInsertField={(field) => {
        onInsert(fieldImageText(field));
      }}
      disabledReason={disabledReason}
      uploader={uploader}
      tabIndex={tabIndex}
      toolId={toolId}
    />
  );
}
