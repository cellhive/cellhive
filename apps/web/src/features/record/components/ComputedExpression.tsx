import { useTranslation } from 'react-i18next';

/**
 * The formula of a formula field under its value in the record panel
 * (T468): only for readers with schema rights — the API gives the
 * expression to nobody else (CONTRACTS §13).
 */
export function ComputedExpression({ expression }: { readonly expression: string }) {
  const { t } = useTranslation('record');
  return (
    <p
      className="px-2 pb-1 font-mono text-mono break-words whitespace-pre-wrap text-fg-muted"
      data-testid="computed-expression"
    >
      <span className="sr-only">{`${t('computed.expression')}: `}</span>
      <span aria-hidden="true">= </span>
      {expression}
    </p>
  );
}
