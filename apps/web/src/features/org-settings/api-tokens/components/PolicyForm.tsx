import { API_TOKEN_MAX_LIFETIME_DAYS, type ApiTokenPolicy } from '@cellhive/contracts';
import { Button, Input, Spinner, Switch } from '@cellhive/ui';
import { TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { showToast } from '../../../../lib/toast/toast';
import { useSetTokenPolicy } from '../api';

import { Note, Section } from './parts';

/** A whole number of days from 1 to 3650, or `null`. */
function parseDays(text: string): number | null {
  if (!/^\d+$/u.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= API_TOKEN_MAX_LIFETIME_DAYS ? value : null;
}

/**
 * "Policy" for organization owners/admins (CONTRACTS §26.4): API tokens on
 * or off (off: every token stops working, a warning says so before saving)
 * and the longest lifetime of new tokens.
 */
export function PolicyForm({
  orgId,
  policy,
}: {
  readonly orgId: string;
  readonly policy: ApiTokenPolicy;
}) {
  const { t } = useTranslation('apiTokens');
  const ids = useId();
  const [enabled, setEnabled] = useState(policy.enabled);
  const [limited, setLimited] = useState(policy.max_lifetime_days !== null);
  const [days, setDays] = useState(String(policy.max_lifetime_days ?? 90));
  const [daysError, setDaysError] = useState(false);
  const save = useSetTokenPolicy(orgId);
  const turningOff = policy.enabled && !enabled;

  return (
    <Section title={t('policy.title')} intro={t('policy.intro')} data-testid="token-policy">
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const max = limited ? parseDays(days) : null;
          if (limited && max === null) {
            setDaysError(true);
            return;
          }
          save.mutate(
            { api_tokens: { enabled, max_lifetime_days: max } },
            {
              onSuccess: () => {
                showToast({ variant: 'success', message: t('policy.saved') });
              },
            },
          );
        }}
      >
        <div className="flex items-start gap-3">
          <Switch
            id={`${ids}-enabled`}
            checked={enabled}
            aria-describedby={`${ids}-enabled-hint`}
            data-testid="token-policy-enabled"
            className="mt-0.5"
            onChange={(event) => {
              setEnabled(event.target.checked);
              save.reset();
            }}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={`${ids}-enabled`} className="text-body font-medium text-fg">
              {t('policy.enabled')}
            </label>
            <p id={`${ids}-enabled-hint`} className="text-label font-normal text-fg-muted">
              {t('policy.enabledHint')}
            </p>
          </div>
        </div>
        {turningOff ? (
          <Note tone="warning" icon={<TriangleAlert />} data-testid="token-policy-off-warning">
            {t('policy.offWarning')}
          </Note>
        ) : null}
        <fieldset className="flex flex-col gap-2" aria-describedby={`${ids}-lifetime-hint`}>
          <legend className="mb-1 text-body font-medium text-fg">{t('policy.lifetime')}</legend>
          <div className="flex items-center gap-2">
            <input
              id={`${ids}-nolimit`}
              type="radio"
              name={`${ids}-lifetime`}
              checked={!limited}
              data-testid="token-policy-nolimit"
              className="size-4 shrink-0 accent-accent"
              onChange={() => {
                setLimited(false);
                setDaysError(false);
              }}
            />
            <label htmlFor={`${ids}-nolimit`} className="text-body text-fg">
              {t('policy.noLimit')}
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={`${ids}-limit`}
              type="radio"
              name={`${ids}-lifetime`}
              checked={limited}
              data-testid="token-policy-limit"
              className="size-4 shrink-0 accent-accent"
              onChange={() => {
                setLimited(true);
              }}
            />
            <label htmlFor={`${ids}-limit`} className="text-body text-fg">
              {t('policy.limit')}
            </label>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={API_TOKEN_MAX_LIFETIME_DAYS}
              value={days}
              disabled={!limited}
              aria-label={t('policy.lifetime')}
              aria-invalid={daysError}
              aria-describedby={daysError ? `${ids}-days-error` : undefined}
              className="w-24"
              data-testid="token-policy-days"
              onChange={(event) => {
                setDays(event.target.value);
                setDaysError(false);
              }}
            />
            <span className="text-body text-fg">{t('policy.days')}</span>
          </div>
          {daysError ? (
            <p id={`${ids}-days-error`} role="alert" className="text-label text-danger">
              {t('policy.lifetimeInvalid')}
            </p>
          ) : null}
          <p id={`${ids}-lifetime-hint`} className="text-label font-normal text-fg-muted">
            {t('policy.lifetimeHint')}
          </p>
        </fieldset>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
        <div className="flex justify-end">
          <Button
            type="submit"
            variant={turningOff ? 'danger' : 'primary'}
            disabled={save.isPending}
            data-testid="token-policy-save"
          >
            {save.isPending ? <Spinner /> : null}
            {t('policy.save')}
          </Button>
        </div>
      </form>
    </Section>
  );
}
