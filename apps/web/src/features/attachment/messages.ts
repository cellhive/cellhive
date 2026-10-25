import { DEFAULT_ATTACHMENT_MAX_FILE_BYTES } from '@cellhive/contracts';
import { fileExtensionOf, type AttachmentOptions } from '@cellhive/field-types';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { acceptLabels } from '../../lib/attachments/checks';
import { formatBytes, formatProgress } from '../../lib/attachments/format';

import type { UploadIssue, UploadItem } from '../../lib/attachments/uploads';

/** HEIC photos (iPhone) are the usual refused image: the board says what to do about it. */
const HEIC = new Set(['heic', 'heif']);

/**
 * The accepted types in words: "JPG, PNG, WEBP", families by name ("images",
 * "videos"); `null` when any file is accepted.
 */
export function useAcceptText(): (accept: readonly string[] | null) => string | null {
  const { t } = useTranslation('attachment');
  return useCallback(
    (accept) => {
      if (accept === null || accept.length === 0) return null;
      return acceptLabels(accept)
        .map((label) =>
          'name' in label
            ? label.name
            : t(`families.${label.family}`, { defaultValue: `${label.family}/*` }),
        )
        .join(', ');
    },
    [t],
  );
}

/**
 * The helper under a drop zone (board): "JPG, PNG, WEBP · up to 100 MB per
 * file · 6 files left".
 */
export function useLimitsText(): (options: AttachmentOptions, remaining: number | null) => string {
  const { t, i18n } = useTranslation('attachment');
  const acceptText = useAcceptText();
  return useCallback(
    (options, remaining) => {
      const parts: string[] = [];
      const types = acceptText(options.accept);
      if (types !== null) parts.push(types);
      parts.push(
        t('limits.perFile', {
          size: formatBytes(DEFAULT_ATTACHMENT_MAX_FILE_BYTES, i18n.language),
        }),
      );
      if (remaining !== null) parts.push(t('limits.left', { count: remaining }));
      return parts.join(' · ');
    },
    [t, i18n.language, acceptText],
  );
}

/** Why an upload stopped, in words (board S4: what happened and what to do). */
export function useIssueText(): (item: UploadItem, options: AttachmentOptions) => string {
  const { t, i18n } = useTranslation('attachment');
  const acceptText = useAcceptText();
  return useCallback(
    (item, options) => {
      const issue: UploadIssue | null = item.issue;
      const language = i18n.language;
      switch (issue?.code) {
        case 'FILE_TOO_LARGE': {
          const limit = issue.params?.['limit'];
          return t('issues.FILE_TOO_LARGE', {
            size: formatBytes(item.size, language),
            limit: formatBytes(
              typeof limit === 'number' ? limit : DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
              language,
            ),
          });
        }
        case 'MIME_NOT_ACCEPTED': {
          const extension = fileExtensionOf(item.name);
          if (HEIC.has(extension)) return t('issues.heic', { type: extension.toUpperCase() });
          const types = acceptText(options.accept);
          return types === null
            ? t('issues.MIME_NOT_ACCEPTED_any')
            : t('issues.MIME_NOT_ACCEPTED', { types });
        }
        case 'BLOCKED_FILE_TYPE': {
          const extension = issue.params?.['extension'];
          return t('issues.BLOCKED_FILE_TYPE', {
            extension:
              typeof extension === 'string' && extension !== ''
                ? extension
                : fileExtensionOf(item.name),
          });
        }
        case 'TOO_MANY_VALUES':
          return t('issues.TOO_MANY_VALUES', { count: options.max_files });
        case 'NETWORK': {
          const loaded = item.loaded;
          return loaded > 0
            ? t('issues.NETWORK_at', { progress: formatProgress(loaded, item.size, language) })
            : t('issues.NETWORK');
        }
        case 'SIZE_MISMATCH':
        case 'CONTENT_MISMATCH':
        case 'UPLOAD_INCOMPLETE':
        case 'INVALID_FORMAT':
        case 'DENIED':
        case 'RATE_LIMITED':
          return t(`issues.${issue.code}`);
        // Form link uploads only (T410): cells never get them.
        case 'UPLOAD_LIMIT_EXCEEDED':
        case 'SUBMIT_TOKEN_INVALID':
        case 'FAILED':
        case undefined:
          return t('issues.FAILED');
      }
    },
    [t, i18n.language, acceptText],
  );
}
