import { useTranslation } from 'react-i18next';

import { Definition, DefinitionGrid, SettingsSection } from './SettingsSection';

import type { EmailSettingsDto } from '@cellhive/contracts';

/** "Limits in force" (CONTRACTS §23.1, SPEC §20): env values, hourly usage of the organization. */
export function LimitsSection({
  settings,
  timeZone,
}: {
  readonly settings: EmailSettingsDto;
  readonly timeZone: string;
}) {
  const { t, i18n } = useTranslation('emailSettings');
  const { limits, usage } = settings;
  const time = new Intl.DateTimeFormat(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(usage.resets_at));
  const kb = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(
    limits.max_html_bytes / 1024,
  );
  return (
    <SettingsSection
      data-testid="limits"
      title={t('limits.title')}
      description={t('limits.description')}
    >
      <DefinitionGrid>
        <Definition term={t('limits.perHour')} data-testid="limit-hour">
          <span className="tabular-nums">
            {t('limits.perHourValue', {
              used: usage.sent_this_hour,
              max: limits.max_per_hour_per_org,
            })}
          </span>{' '}
          <span className="text-label font-normal text-fg-muted">
            ({t('limits.resetsAt', { time })})
          </span>
        </Definition>
        <Definition term={t('limits.recipients')} data-testid="limit-recipients">
          <span className="tabular-nums">
            {new Intl.NumberFormat(i18n.language).format(limits.max_recipients)}
          </span>
        </Definition>
        <Definition term={t('limits.perSecond')}>
          <span className="tabular-nums">
            {new Intl.NumberFormat(i18n.language).format(limits.max_per_second_per_process)}
          </span>
        </Definition>
        <Definition term={t('limits.tests')} data-testid="limit-tests">
          {t('limits.testsValue', { count: limits.test_sends_per_minute })}
        </Definition>
        <Definition term={t('limits.html')}>
          {t('limits.htmlValue', { size: `${kb} KB` })}
        </Definition>
      </DefinitionGrid>
    </SettingsSection>
  );
}
