import { cn, Spinner, Switch } from '@cellhive/ui';
import { Check, CircleCheck, CircleMinus, Sparkles, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { showToast } from '../../../../lib/toast/toast';
import { SettingsSection } from '../../email/components/SettingsSection';
import { useUpdateAiSettings } from '../api';
import { displayHostOf } from '../model';

import type { AiSettingsDto } from '@cellhive/contracts';

type Status = 'on' | 'off' | 'notSetUp';

function StatusBadge({ status }: { readonly status: Status }) {
  const { t } = useTranslation('orgAi');
  const Icon = status === 'on' ? CircleCheck : status === 'off' ? CircleMinus : TriangleAlert;
  return (
    <span
      data-testid="ai-status-badge"
      className="inline-flex h-6 items-center gap-1 rounded-sm border border-line bg-surface-sunken px-2 text-label font-medium whitespace-nowrap text-fg"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'size-3.5',
          status === 'on' && 'text-success',
          status === 'off' && 'text-fg-muted',
          status === 'notSetUp' && 'text-warning',
        )}
      />
      {t(`status.${status}`)}
    </span>
  );
}

/**
 * Status of AI in the organization with its switch (applies at once,
 * F§9.2): off until a provider URL and a model are saved. While AI is off,
 * the three setup steps say what is left; not set up at all, the card is
 * the page's empty state.
 */
export function StatusSection({
  orgId,
  orgName,
  settings,
}: {
  readonly orgId: string;
  readonly orgName: string;
  readonly settings: AiSettingsDto;
}) {
  const { t } = useTranslation('orgAi');
  const save = useUpdateAiSettings(orgId);
  const id = useId();
  const configured = settings.provider_base_url !== null && settings.model !== null;
  const host = displayHostOf(settings.provider_base_url) ?? '';
  const status: Status = !configured ? 'notSetUp' : settings.enabled ? 'on' : 'off';
  const steps = [
    { key: 'provider', done: configured },
    { key: 'test', done: settings.detected_output !== null },
    { key: 'enable', done: settings.enabled },
  ] as const;
  const hint = !configured
    ? t('status.needsProvider')
    : settings.enabled
      ? t('status.onHint', { model: settings.model, host })
      : t('status.offHint', { host });

  return (
    <SettingsSection
      data-testid="ai-status"
      title={t('status.title', { org: orgName })}
      badge={<StatusBadge status={status} />}
    >
      {configured ? null : (
        <div className="flex items-start gap-3" data-testid="ai-empty">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"
          >
            <Sparkles className="size-5" />
          </span>
          <p className="max-w-[60ch] text-body text-fg-muted">{t('status.intro')}</p>
        </div>
      )}
      <div className="flex items-center gap-4 rounded-md border border-line bg-surface-sunken px-3 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={id} className="flex items-center gap-2 text-body font-medium text-fg">
            {t('status.switch')}
            {save.isPending ? <Spinner className="size-3.5 text-fg-muted" /> : null}
          </label>
          <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
            {hint}
          </p>
        </div>
        <Switch
          id={id}
          data-testid="ai-enabled"
          checked={settings.enabled}
          disabled={!configured || save.isPending}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            const enabled = event.currentTarget.checked;
            save.mutate(
              { enabled },
              {
                onSuccess: () => {
                  showToast({
                    variant: 'success',
                    message: t(enabled ? 'status.turnedOn' : 'status.turnedOff', { org: orgName }),
                  });
                },
              },
            );
          }}
        />
      </div>
      {save.isError ? <ErrorAlert error={save.error} /> : null}
      {settings.enabled ? null : (
        <ol
          aria-label={t('status.steps.label')}
          className="flex flex-col gap-2 sm:flex-row sm:gap-4"
        >
          {steps.map((step, index) => (
            <li
              key={step.key}
              data-testid={`ai-step-${step.key}`}
              data-done={step.done}
              className="flex min-w-0 flex-1 items-center gap-2 text-label font-normal text-fg-muted"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border text-label font-medium transition-colors',
                  step.done
                    ? 'border-accent bg-accent text-on-accent'
                    : 'border-line-control bg-surface text-fg-muted',
                )}
              >
                {step.done ? <Check className="size-3 motion-safe:animate-pop-in" /> : index + 1}
              </span>
              <span className={cn(step.done && 'text-fg')}>
                {t(`status.steps.${step.key}`)}
                {step.done ? <span className="sr-only"> {t('status.done')}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </SettingsSection>
  );
}
