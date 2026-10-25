import {
  INCOMING_WEBHOOK_BURST_FACTOR,
  INCOMING_WEBHOOK_RATE_SCHEMA_MAX,
  MAX_INCOMING_WEBHOOK_NAME_LENGTH,
  type IncomingWebhookDto,
  type IncomingWebhookWithSecretsDto,
  type UpdateIncomingWebhookRequest,
} from '@cellhive/contracts';
import { Button, cn, FormField, Input, Spinner, Switch } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { showToast } from '../../../../lib/toast/toast';
import { incomingWebhooksApi } from '../api';
import { useHookCache } from '../cache';
import {
  authWithout,
  draftErrors,
  hasCheck,
  idempotencyKey,
  parseRate,
  type AuthCheck,
} from '../model';

import { ConfirmDialog } from './ConfirmDialog';
import { CopyField, Note } from './parts';
import { UsageList } from './UsageList';

import type { RevealReason } from './SecretRevealDialog';

/** Actions confirmed first: each changes what the sending system must send. */
type Action =
  | 'rotate'
  | 'addSignature'
  | 'removeSignature'
  | 'replaceBearer'
  | 'addBearer'
  | 'removeBearer'
  | 'regenerate';

export interface WebhookSettingsProps {
  readonly baseId: string;
  readonly hook: IncomingWebhookDto;
  readonly onRevealed: (reason: RevealReason, hook: IncomingWebhookWithSecretsDto) => void;
  readonly onDelete: () => void;
}

/**
 * The settings tab of a webhook (CONTRACTS §25.1, BACKLOG T611): receive
 * on/off (a switch: applies at once), the URL (copy, get a new one), the
 * two checks — signing secret (rotate with 24 h overlap, add, remove) and
 * Bearer token (replace, add, remove) — following T602's flow (a check is
 * added only by issuing its credential), name and rate limit (saved
 * together), the automations it triggers, and delete.
 */
export function WebhookSettings({ baseId, hook, onRevealed, onDelete }: WebhookSettingsProps) {
  const { t } = useTranslation('incomingWebhooks');
  const format = useFormatters();
  const { put } = useHookCache(baseId);
  const [pending, setPending] = useState<Action | null>(null);
  const [rotateKey, setRotateKey] = useState(idempotencyKey);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => incomingWebhooksApi.update(hook.id, { enabled }),
    onSuccess: (updated) => {
      put(updated);
      showToast({
        variant: 'success',
        message: t(updated.enabled ? 'toast.enabled' : 'toast.disabled', { name: updated.name }),
      });
    },
  });
  const act = useMutation({
    mutationFn: async (action: Action): Promise<IncomingWebhookDto> => {
      switch (action) {
        case 'rotate':
        case 'addSignature':
          return incomingWebhooksApi.rotateSecret(hook.id, rotateKey);
        case 'replaceBearer':
        case 'addBearer':
          return incomingWebhooksApi.setBearer(hook.id);
        case 'removeBearer':
          return incomingWebhooksApi.removeBearer(hook.id);
        case 'removeSignature':
          return incomingWebhooksApi.update(hook.id, { auth: authWithout(hook.auth, 'signature') });
        case 'regenerate':
          return incomingWebhooksApi.regenerateToken(hook.id);
      }
    },
    onSuccess: (updated, action) => {
      put(updated);
      setPending(null);
      if (action === 'rotate' || action === 'addSignature') {
        setRotateKey(idempotencyKey());
        onRevealed('rotated', updated as IncomingWebhookWithSecretsDto);
      } else if (action === 'replaceBearer' || action === 'addBearer') {
        onRevealed('bearer', updated as IncomingWebhookWithSecretsDto);
      } else {
        showToast({ variant: 'success', message: t(`toast.${action}`, { name: updated.name }) });
      }
    },
  });
  const ask = (action: Action) => {
    act.reset();
    setPending(action);
  };
  const checks: readonly AuthCheck[] = ['signature', 'bearer'];
  const enabledId = useId();

  return (
    <div className="flex flex-col gap-6" data-testid="hook-settings">
      <Section title={t('settings.receive')}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={enabledId} className="text-body font-medium text-fg">
              {t('settings.enabled')}
            </label>
            <span className="text-label font-normal text-fg-muted">
              {t(hook.enabled ? 'settings.enabledOn' : 'settings.enabledOff')}
            </span>
          </div>
          <Switch
            id={enabledId}
            checked={hook.enabled}
            disabled={toggle.isPending}
            data-testid="hook-enabled"
            onChange={(event) => {
              toggle.mutate(event.target.checked);
            }}
          />
        </div>
        {toggle.isError ? <ErrorAlert error={toggle.error} /> : null}
      </Section>

      <Section title={t('settings.url')}>
        <CopyField
          label={t('settings.urlLabel')}
          value={hook.url}
          hint={t('settings.urlHint')}
          data-testid="hook-url"
        />
        <div>
          <Button
            variant="secondary"
            data-testid="hook-regenerate"
            onClick={() => {
              ask('regenerate');
            }}
          >
            <RefreshCw aria-hidden="true" />
            {t('settings.regenerate')}
          </Button>
        </div>
      </Section>

      <Section title={t('settings.auth')}>
        {hook.auth === 'none' ? (
          <Note
            tone="warning"
            icon={<ShieldAlert />}
            title={t('auth.noneWarningTitle')}
            data-testid="hook-none-warning"
          >
            {t('auth.noneWarning')}
          </Note>
        ) : null}
        <ul className="flex flex-col rounded-lg border border-line">
          {checks.map((check) => {
            const on = hasCheck(hook.auth, check);
            return (
              <li
                key={check}
                data-testid={`hook-check-${check}`}
                className="flex flex-col gap-2 border-t border-line px-3 py-3 first:border-t-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                  <span className="font-medium text-fg">{t(`check.${check}.name`)}</span>
                  <span
                    className={cn(
                      'rounded-sm px-1.5 py-0.5 text-label font-medium',
                      on ? 'bg-accent-soft text-accent' : 'bg-surface-sunken text-fg-muted',
                    )}
                  >
                    {t(on ? 'check.on' : 'check.off')}
                  </span>
                </div>
                <p className="text-label font-normal text-fg-muted">
                  {t(`check.${check}.explain`)}
                </p>
                {check === 'signature' && on && hook.signing_secret_rotating_until !== null ? (
                  <p className="text-label font-normal text-fg" data-testid="hook-rotating">
                    {t('check.signature.rotating', {
                      date: format.dateTime(hook.signing_secret_rotating_until),
                    })}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {check === 'signature' ? (
                    on ? (
                      <>
                        <Button
                          variant="secondary"
                          data-testid="hook-rotate"
                          onClick={() => {
                            ask('rotate');
                          }}
                        >
                          {t('check.signature.rotate')}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            ask('removeSignature');
                          }}
                        >
                          {t('check.remove')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="secondary"
                        data-testid="hook-add-signature"
                        onClick={() => {
                          ask('addSignature');
                        }}
                      >
                        {t('check.signature.add')}
                      </Button>
                    )
                  ) : on ? (
                    <>
                      <Button
                        variant="secondary"
                        data-testid="hook-replace-bearer"
                        onClick={() => {
                          ask('replaceBearer');
                        }}
                      >
                        {t('check.bearer.replace')}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          ask('removeBearer');
                        }}
                      >
                        {t('check.remove')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="secondary"
                      data-testid="hook-add-bearer"
                      onClick={() => {
                        ask('addBearer');
                      }}
                    >
                      {t('check.bearer.add')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={t('settings.general')}>
        <GeneralForm
          key={`${hook.id}:${hook.name}:${String(hook.rate_limit_per_sec)}`}
          baseId={baseId}
          hook={hook}
        />
      </Section>

      <Section title={t('settings.usages')}>
        {hook.usages.length === 0 ? (
          <p className="text-body text-fg-muted">{t('usages.none')}</p>
        ) : (
          <UsageList baseId={baseId} usages={hook.usages} data-testid="hook-usages" />
        )}
      </Section>

      <Section title={t('settings.danger')}>
        <div>
          <Button
            variant="secondary"
            className="text-danger"
            data-testid="hook-delete"
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
            {t('delete.action')}
          </Button>
        </div>
      </Section>

      <ConfirmDialog
        open={pending !== null}
        title={pending === null ? '' : t(`confirm.${pending}.title`)}
        description={pending === null ? undefined : t(`confirm.${pending}.body`)}
        confirmLabel={pending === null ? '' : t(`confirm.${pending}.confirm`)}
        tone={pending === 'addSignature' || pending === 'addBearer' ? 'primary' : 'danger'}
        pending={act.isPending}
        error={act.isError ? act.error : undefined}
        data-testid="hook-confirm"
        onCancel={() => {
          setPending(null);
        }}
        onConfirm={() => {
          if (pending !== null) act.mutate(pending);
        }}
      >
        {pending !== null && removesLastCheck(hook, pending) ? (
          <Note tone="warning" icon={<ShieldAlert />}>
            {t('confirm.leavesNone')}
          </Note>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function removesLastCheck(hook: IncomingWebhookDto, action: Action): boolean {
  if (action === 'removeSignature') return authWithout(hook.auth, 'signature') === 'none';
  if (action === 'removeBearer') return authWithout(hook.auth, 'bearer') === 'none';
  return false;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-label font-semibold tracking-wide text-fg-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** Name and rate limit, saved together (`PATCH`, only the changed keys). */
function GeneralForm({
  baseId,
  hook,
}: {
  readonly baseId: string;
  readonly hook: IncomingWebhookDto;
}) {
  const { t } = useTranslation('incomingWebhooks');
  const { put } = useHookCache(baseId);
  const [name, setName] = useState(hook.name);
  const [rate, setRate] = useState(String(hook.rate_limit_per_sec));
  const [submitted, setSubmitted] = useState(false);
  const errors = draftErrors({ name, rate });
  const shown = submitted ? errors : {};
  const patch: UpdateIncomingWebhookRequest = {
    ...(name.trim() === hook.name ? {} : { name: name.trim() }),
    ...(parseRate(rate) === hook.rate_limit_per_sec || parseRate(rate) === null
      ? {}
      : { rate_limit_per_sec: parseRate(rate) ?? undefined }),
  };
  const changed = Object.keys(patch).length > 0;
  const save = useMutation({
    mutationFn: () => incomingWebhooksApi.update(hook.id, patch),
    onSuccess: (updated) => {
      put(updated);
      showToast({ variant: 'success', message: t('toast.saved', { name: updated.name }) });
    },
  });
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (Object.keys(errors).length === 0 && changed) save.mutate();
      }}
    >
      <FormField
        label={t('form.name')}
        error={shown.name === undefined ? undefined : t(`form.errors.${shown.name}`)}
      >
        {(control) => (
          <Input
            {...control}
            value={name}
            maxLength={MAX_INCOMING_WEBHOOK_NAME_LENGTH}
            autoComplete="off"
            data-testid="hook-edit-name"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
      </FormField>
      <FormField
        label={t('form.rate')}
        hint={t('form.rateHint', { burst: INCOMING_WEBHOOK_BURST_FACTOR })}
        error={shown.rate === undefined ? undefined : t('form.errors.rate')}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={1}
            max={INCOMING_WEBHOOK_RATE_SCHEMA_MAX}
            step={1}
            value={rate}
            className="w-32"
            data-testid="hook-edit-rate"
            onChange={(event) => {
              setRate(event.target.value);
            }}
          />
        )}
      </FormField>
      {save.isError ? <ErrorAlert error={save.error} /> : null}
      <div>
        <Button type="submit" disabled={!changed || save.isPending} data-testid="hook-save">
          {save.isPending ? <Spinner /> : null}
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
