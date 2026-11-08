import { CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../lib/api/client';
import { RequestId } from '../../../lib/errors/RequestId';
import { translateDetail, translateError, type Translator } from '../../../lib/errors/translate';

import type { ProblemErrorItem } from '@cellhive/contracts';
import type { ReactNode } from 'react';

/**
 * The code of the instance behind an `INVALID_DEFINITION` / `INVALID_ENTRY`
 * (`params.code`, CONTRACTS §12.2: `FORMULA_CYCLE`, `AUTOMATION_INVALID`,
 * a name already taken…), in words when the app knows it, else as is.
 */
export function reasonOf(translator: Translator, item: ProblemErrorItem): string | null {
  const code = item.params?.['code'];
  if (typeof code !== 'string' || code === '') return null;
  for (const key of [`errors:detail.${code}`, `errors:codes.${code}`]) {
    if (translator.exists(key)) return translator.t(key, { ...item.params });
  }
  return code;
}

export interface ImportProblemsProps {
  /** The error of the failed job (problem+json as an `ApiError`). */
  readonly error: unknown;
  /** `params.more_problems`: problems past the 100 listed. */
  readonly more: number;
  readonly actions: ReactNode;
}

/**
 * Why a `.chbase` import failed (CONTRACTS §12.2): for `INVALID_PACKAGE`
 * every problem found (up to 100, then "And N more") with its message by
 * detail code, the reason of the instance (`params.code`) and where in the
 * package (`path`: an entry, a JSON pointer, a line); other failures by
 * their code. An import that fails leaves nothing behind, and says so.
 */
export function ImportProblems({ error, more, actions }: ImportProblemsProps) {
  const { t, i18n } = useTranslation('workspace');
  const translated = translateError(error, i18n);
  const items = isApiError(error) ? error.errors : [];
  return (
    <div className="flex animate-reveal flex-col gap-4" data-testid="import-error">
      <div role="alert" className="flex flex-col gap-3 rounded-md border border-danger p-3">
        <div className="flex gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="font-medium">{t('import.failed.title')}</p>
            <p className="text-fg-muted">{translated.message}</p>
          </div>
        </div>
        {items.length === 0 ? null : (
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {items.map((item, index) => {
              const reason = reasonOf(i18n, item);
              return (
                <li
                  // A path may come back for two problems.
                  key={`${item.path}:${item.code}:${String(index)}`}
                  className="flex flex-col gap-1 py-2 last:pb-0"
                  data-testid="import-problem"
                >
                  <span>{translateDetail(i18n, item)}</span>
                  {reason === null ? null : (
                    <span className="text-fg-muted">{t('import.failed.reason', { reason })}</span>
                  )}
                  {item.path === '' ? null : (
                    <code className="font-mono text-label font-normal break-all text-fg-muted">
                      {item.path}
                    </code>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {more > 0 ? (
          <p className="text-fg-muted">{t('import.failed.more', { count: more })}</p>
        ) : null}
        {translated.requestId === undefined ? null : <RequestId requestId={translated.requestId} />}
      </div>
      <p className="text-fg-muted">{t('import.failed.nothingLeft')}</p>
      <div className="flex flex-wrap justify-end gap-2">{actions}</div>
    </div>
  );
}
