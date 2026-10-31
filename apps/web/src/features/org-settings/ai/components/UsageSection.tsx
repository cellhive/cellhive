import { cn, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { SettingsSection } from '../../email/components/SettingsSection';
import { aiUsageQuery } from '../api';
import { quotaShare, usageByFeature } from '../model';

const TH = 'h-[34px] px-3 text-left text-label font-medium whitespace-nowrap text-fg-muted';
const TD = 'px-3 py-2 align-middle';

/**
 * Today's quota (used, limit, when it resets) and the last 30 days by
 * feature (CONTRACTS §29.1 `GET …/ai-usage`). Tokens are prompt + answer;
 * a feature whose provider did not report tokens is marked estimated.
 */
export function UsageSection({ orgId }: { readonly orgId: string }) {
  const { t } = useTranslation('orgAi');
  const format = useFormatters();
  const usage = useQuery(aiUsageQuery(orgId));
  const data = usage.data;
  const rows = data === undefined ? [] : usageByFeature(data.items);
  const share = data === undefined ? null : quotaShare(data.quota);
  const total = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      tokens: sum.tokens + row.promptTokens + row.completionTokens,
    }),
    { requests: 0, tokens: 0 },
  );
  const estimated = rows.some((row) => row.estimated);

  return (
    <SettingsSection
      data-testid="ai-usage"
      title={t('usage.title')}
      description={t('usage.description')}
    >
      {usage.error !== null ? (
        <ErrorAlert error={usage.error} />
      ) : data === undefined ? (
        <div aria-hidden="true" className="flex flex-col gap-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-sunken px-3 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-label text-fg">{t('usage.today')}</span>
              <span className="text-body text-fg tabular-nums" data-testid="ai-usage-today">
                {data.quota.daily_token_limit === null
                  ? t('usage.todayUnlimited', { used: format.number(data.quota.used_today) })
                  : t('usage.todayValue', {
                      used: format.number(data.quota.used_today),
                      limit: format.number(data.quota.daily_token_limit),
                    })}
              </span>
            </div>
            {share === null ? null : (
              <div
                role="meter"
                aria-label={t('usage.meter')}
                aria-valuemin={0}
                aria-valuemax={data.quota.daily_token_limit ?? 0}
                aria-valuenow={Math.min(data.quota.used_today, data.quota.daily_token_limit ?? 0)}
                aria-valuetext={t('usage.todayValue', {
                  used: format.number(data.quota.used_today),
                  limit: format.number(data.quota.daily_token_limit ?? 0),
                })}
                className="h-1.5 overflow-hidden rounded-full bg-line"
              >
                <div
                  className={cn(
                    'h-full origin-left rounded-full transition-transform duration-(--motion-sheet) motion-reduce:transition-none',
                    share >= 1 ? 'bg-danger' : share >= 0.8 ? 'bg-warning' : 'bg-accent',
                  )}
                  // A transform, not a width: the bar grows without layout.
                  style={{ transform: `scaleX(${String(share)})` }}
                />
              </div>
            )}
            <span className="text-label font-normal text-fg-muted" data-testid="ai-usage-reset">
              {t('usage.resets', { time: format.dateTime(data.quota.reset_at) })}
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="text-body text-fg-muted" data-testid="ai-usage-empty">
              {t('usage.empty')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full border-collapse text-body" data-testid="ai-usage-table">
                <thead className="bg-surface-sunken">
                  <tr>
                    <th scope="col" className={TH}>
                      {t('usage.feature')}
                    </th>
                    <th scope="col" className={cn(TH, 'text-right')}>
                      {t('usage.requests')}
                    </th>
                    <th scope="col" className={cn(TH, 'text-right')}>
                      {t('usage.tokens')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.feature}
                      className="border-t border-line"
                      data-testid="ai-usage-row"
                    >
                      <th scope="row" className={cn(TD, 'text-left font-normal')}>
                        {t(`usage.features.${row.feature}`)}
                      </th>
                      <td className={cn(TD, 'text-right tabular-nums')}>
                        {format.number(row.requests)}
                      </td>
                      <td className={cn(TD, 'text-right tabular-nums')}>
                        {row.estimated ? (
                          <>
                            <span aria-hidden="true">≈ </span>
                            <span className="sr-only">{t('usage.estimatedMark')} </span>
                          </>
                        ) : null}
                        {format.number(row.promptTokens + row.completionTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line-strong font-medium">
                    <th scope="row" className={cn(TD, 'text-left font-medium')}>
                      {t('usage.total')}
                    </th>
                    <td className={cn(TD, 'text-right tabular-nums')}>
                      {format.number(total.requests)}
                    </td>
                    <td className={cn(TD, 'text-right tabular-nums')}>
                      {format.number(total.tokens)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {estimated ? (
            <p className="text-label font-normal text-fg-muted">{t('usage.estimated')}</p>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
