import {
  AI_MAX_DAILY_TOKEN_LIMIT,
  AI_MAX_REQUEST_TIMEOUT_SECONDS,
  AI_MIN_DAILY_TOKEN_LIMIT,
  AI_MIN_REQUEST_TIMEOUT_SECONDS,
  AI_STRUCTURED_OUTPUTS,
  AI_TOKEN_PARAMS,
  type AiSettingsDto,
  type AiStructuredOutput,
  type AiTokenParam,
} from '@cellhive/contracts';
import { cn, FormField, Input, Select } from '@cellhive/ui';
import { ChevronRight } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from '../../email/components/SettingsSection';

import type { AiDraft, DraftField } from '../model';

/**
 * Daily token quota (a number or "No limit") and, folded away, the
 * provider details few people change: answer format, the output token
 * parameter, the request timeout. Part of the page's draft ("Save changes").
 */
export function LimitsSection({
  settings,
  draft,
  errors,
  onChange,
}: {
  readonly settings: AiSettingsDto;
  readonly draft: AiDraft;
  readonly errors: Partial<Record<DraftField, string>>;
  readonly onChange: (patch: Partial<AiDraft>) => void;
}) {
  const { t } = useTranslation('orgAi');
  const legendId = useId();
  const limitId = useId();
  const radio = 'size-4 shrink-0 accent-accent';
  const detected = settings.detected_output;
  return (
    <SettingsSection
      data-testid="ai-limits"
      title={t('limits.title')}
      description={t('limits.description')}
    >
      <fieldset aria-labelledby={legendId} className="flex flex-col gap-2">
        <legend id={legendId} className="mb-1 text-label text-fg">
          {t('limits.quota')}
        </legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6">
          <label className="flex min-h-control items-center gap-2 text-body text-fg lg:min-h-8">
            <input
              type="radio"
              name={legendId}
              className={radio}
              data-testid="ai-quota-limited"
              checked={!draft.unlimited}
              onChange={() => {
                onChange({ unlimited: false });
              }}
            />
            {t('limits.limited')}
          </label>
          <label className="flex min-h-control items-center gap-2 text-body text-fg lg:min-h-8">
            <input
              type="radio"
              name={legendId}
              className={radio}
              data-testid="ai-quota-unlimited"
              checked={draft.unlimited}
              onChange={() => {
                onChange({ unlimited: true });
              }}
            />
            {t('limits.unlimited')}
          </label>
        </div>
        {draft.unlimited ? null : (
          <div className="flex max-w-xs flex-col gap-1 motion-safe:animate-reveal">
            <label htmlFor={limitId} className="text-label text-fg">
              {t('limits.limitedValue')}
            </label>
            <Input
              id={limitId}
              inputMode="numeric"
              autoComplete="off"
              className="tabular-nums"
              data-testid="ai-quota"
              aria-invalid={errors.limit !== undefined}
              aria-describedby={`${limitId}-hint`}
              value={draft.limit}
              onChange={(event) => {
                onChange({ limit: event.target.value });
              }}
            />
            <p
              id={`${limitId}-hint`}
              className={cn(
                'text-label font-normal',
                errors.limit === undefined ? 'text-fg-muted' : 'text-danger',
              )}
            >
              {errors.limit ??
                t('limits.limitHint', {
                  min: AI_MIN_DAILY_TOKEN_LIMIT,
                  max: AI_MAX_DAILY_TOKEN_LIMIT,
                })}
            </p>
          </div>
        )}
      </fieldset>

      <details className="group rounded-md border border-line" data-testid="ai-advanced">
        <summary className="flex min-h-control cursor-pointer list-none items-center gap-2 rounded-md px-3 text-body font-medium text-fg hover:bg-surface-sunken lg:min-h-9 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-fg-muted transition-transform duration-(--motion-enter) group-open:rotate-90 motion-reduce:transition-none"
          />
          {t('limits.advanced')}
        </summary>
        <div className="grid grid-cols-1 gap-4 border-t border-line p-3 motion-safe:animate-reveal sm:grid-cols-2">
          <FormField label={t('limits.format')} hint={t('limits.formatHint')}>
            {(control) => (
              <Select
                {...control}
                data-testid="ai-structured-output"
                value={draft.structuredOutput}
                onChange={(event) => {
                  onChange({ structuredOutput: event.target.value as AiStructuredOutput });
                }}
              >
                {AI_STRUCTURED_OUTPUTS.map((value) => (
                  <option key={value} value={value}>
                    {value === 'auto' && detected !== null
                      ? t('limits.formats.autoDetected', {
                          format: t(`limits.formats.${detected}`),
                        })
                      : t(`limits.formats.${value}`)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={t('limits.tokenParam')} hint={t('limits.tokenParamHint')}>
            {(control) => (
              <Select
                {...control}
                className="font-mono"
                data-testid="ai-token-param"
                value={draft.tokenParam}
                onChange={(event) => {
                  onChange({ tokenParam: event.target.value as AiTokenParam });
                }}
              >
                {AI_TOKEN_PARAMS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField
            label={t('limits.timeout')}
            hint={t('limits.timeoutHint', {
              min: AI_MIN_REQUEST_TIMEOUT_SECONDS,
              max: AI_MAX_REQUEST_TIMEOUT_SECONDS,
            })}
            error={errors.timeout}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                autoComplete="off"
                className="tabular-nums"
                data-testid="ai-timeout"
                value={draft.timeout}
                onChange={(event) => {
                  onChange({ timeout: event.target.value });
                }}
              />
            )}
          </FormField>
        </div>
      </details>
    </SettingsSection>
  );
}
