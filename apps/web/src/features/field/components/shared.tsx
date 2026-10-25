import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { translateDetail } from '../../../lib/errors/translate';

import type { DraftIssue } from '../draft';

export { TYPE_ICONS } from '../../../lib/schema/field-icons';

/** Detail codes the field form produces itself (translated in the `field` namespace). */
const LOCAL_CODES = new Set(['DUPLICATE_OPTION', 'NAME_CONFLICT']);

/** Translates a {@link DraftIssue} (or a server detail placed on a form control). */
export function useIssueText(): (issue: DraftIssue | undefined) => string | undefined {
  const { t, i18n } = useTranslation(['field', 'errors']);
  return useCallback(
    (issue) => {
      if (issue === undefined) return undefined;
      if (LOCAL_CODES.has(issue.detail.code)) return t(`field:validation.${issue.detail.code}`);
      return translateDetail(i18n, issue.detail);
    },
    [t, i18n],
  );
}

/** The issue at `path`, if any. */
export function issueAt(issues: readonly DraftIssue[], path: string): DraftIssue | undefined {
  return issues.find((issue) => issue.path === path);
}

/** Issues under `prefix` (e.g. `options.style`). */
export function issuesUnder(issues: readonly DraftIssue[], prefix: string): DraftIssue[] {
  return issues.filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`));
}
