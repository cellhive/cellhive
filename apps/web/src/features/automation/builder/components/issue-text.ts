import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { translateDetail } from '../../../../lib/errors/translate';
import { CLIENT_ISSUE_CODES } from '../model/check';

import type { BuilderIssue } from '../model/issues';

const CLIENT: ReadonlySet<string> = new Set(CLIENT_ISSUE_CODES);

/**
 * Text of an issue: the builder's own codes from `automationBuilder:issues`,
 * the server's detail codes from `errors:detail` (CONTRACTS §6; unknown →
 * the server's English message).
 */
export function useIssueText(): (issue: BuilderIssue) => string {
  const { t, i18n } = useTranslation(['automationBuilder', 'errors']);
  return useCallback(
    (issue: BuilderIssue) =>
      CLIENT.has(issue.code)
        ? t(`automationBuilder:issues.${issue.code}` as 'automationBuilder:issues.REQUIRED', {
            ...(issue.params ?? {}),
          })
        : // (T613) The shared text names a Telegram bot: HTTP secrets get their own.
          issue.code === 'SECRET_NOT_USABLE' && issue.path !== 'config.secret_id'
          ? t('automationBuilder:issues.SECRET_NOT_USABLE_HTTP')
          : translateDetail(i18n, {
              code: issue.code,
              params: issue.params ?? {},
              ...(issue.message === undefined ? {} : { message: issue.message }),
            }),
    [t, i18n],
  );
}
