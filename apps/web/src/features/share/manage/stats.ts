import type { ShareLinkDto } from '@cellhive/contracts';
import type { TFunction } from 'i18next';

/**
 * How often a link was opened, worded the same in the share dialog and in
 * the settings lists (T320 QA: "Never" in one, "Opened 1 time" in the
 * other). Both read `access_count` and `last_accessed_at` of the same
 * `ShareLink`; a link is "not opened yet" only when neither says otherwise.
 */
export function accessSummary(
  t: TFunction<'share'>,
  link: Pick<ShareLinkDto, 'access_count' | 'last_accessed_at'>,
  when: (iso: string) => string,
): string {
  if (link.last_accessed_at === null) {
    return link.access_count === 0
      ? t('link.neverOpened')
      : t('link.opened', { count: link.access_count });
  }
  return t('link.stats', { count: link.access_count, when: when(link.last_accessed_at) });
}
