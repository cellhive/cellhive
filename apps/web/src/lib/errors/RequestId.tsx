import { Button, cn } from '@cellhive/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Characters of a `req_…` id shown before the ellipsis; the copy button copies all of it. */
const SHORT_LENGTH = 12;

/**
 * The request ID of a failed call, shortened, with a copy button
 * (FRONTEND §8.1): users quote it when reporting a problem.
 */
export function RequestId({
  requestId,
  compact = false,
  className,
}: {
  requestId: string;
  /** Shorten the id (toasts); the full id stays in the tooltip and the clipboard. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation('errors');
  const [copied, setCopied] = useState(false);
  const short =
    compact && requestId.length > SHORT_LENGTH ? `${requestId.slice(0, SHORT_LENGTH)}…` : requestId;
  return (
    <p
      className={cn(
        'flex flex-wrap items-center gap-2 text-label font-normal text-fg-muted',
        className,
      )}
    >
      <span>
        {t('requestId')} <code title={requestId}>{short}</code>
      </span>
      <Button
        variant="link"
        size="sm"
        onClick={() => {
          // The Clipboard API exists only in secure contexts (HTTPS or localhost).
          if (!('clipboard' in navigator)) return;
          navigator.clipboard.writeText(requestId).then(
            () => {
              setCopied(true);
            },
            () => undefined,
          );
        }}
      >
        {copied ? t('copied') : t('copyRequestId')}
      </Button>
    </p>
  );
}
