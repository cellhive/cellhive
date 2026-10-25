import { Alert } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { RequestId } from './RequestId';
import { translateError, type TranslateOptions } from './translate';

export interface ErrorAlertProps extends TranslateOptions {
  error: unknown;
  /** `errors[]` paths already shown next to form fields. */
  hidePaths?: readonly string[];
  className?: string;
}

/** Translated problem+json message with details and a copyable request ID. */
export function ErrorAlert({ error, overrides, hidePaths = [], className }: ErrorAlertProps) {
  const { i18n } = useTranslation('errors');
  const translated = translateError(error, i18n, overrides === undefined ? {} : { overrides });
  const details = translated.details.filter((detail) => !hidePaths.includes(detail.path));
  const requestId = translated.requestId;
  return (
    <Alert variant="danger" className={className}>
      <p>{translated.message}</p>
      {details.length > 0 ? (
        <ul className="list-disc pl-4 text-fg-muted">
          {details.map((detail) => (
            <li key={`${detail.path}:${detail.message}`}>{detail.message}</li>
          ))}
        </ul>
      ) : null}
      {requestId === undefined ? null : <RequestId requestId={requestId} />}
    </Alert>
  );
}
