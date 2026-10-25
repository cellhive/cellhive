import {
  INCOMING_WEBHOOK_BURST_FACTOR,
  INCOMING_WEBHOOK_DEFAULT_RATE_PER_SEC,
  INCOMING_WEBHOOK_RATE_SCHEMA_MAX,
  MAX_INCOMING_WEBHOOK_NAME_LENGTH,
  type IncomingWebhookAuth,
  type IncomingWebhookWithSecretsDto,
} from '@cellhive/contracts';
import { Button, Checkbox, cn, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { incomingWebhooksApi } from '../api';
import { draftErrors, idempotencyKey, parseRate } from '../model';

import { Note } from './parts';

/** Choices in the order shown; the UI default is `bearer` (BACKLOG T611). */
const AUTH_CHOICES: readonly IncomingWebhookAuth[] = ['bearer', 'both', 'signature', 'none'];

export interface CreateWebhookDialogProps {
  readonly baseId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (hook: IncomingWebhookWithSecretsDto) => void;
}

/**
 * "New webhook" (CONTRACTS §25.1 `POST /bases/:id/incoming-webhooks`): a
 * name, the checks of the public route — chosen explicitly (BACKLOG
 * "Quyết định S5c" #8), `bearer` preselected, `none` only after
 * acknowledging that anyone with the URL can send data — and the rate limit.
 */
export function CreateWebhookDialog({
  baseId,
  open,
  onClose,
  onCreated,
}: CreateWebhookDialogProps) {
  const { t } = useTranslation('incomingWebhooks');
  return (
    <Dialog
      open={open}
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('create.title')}
      description={t('create.description')}
      closeLabel={t('common.close')}
    >
      {open ? <CreateForm baseId={baseId} onClose={onClose} onCreated={onCreated} /> : null}
    </Dialog>
  );
}

function CreateForm({ baseId, onClose, onCreated }: Omit<CreateWebhookDialogProps, 'open'>) {
  const { t } = useTranslation('incomingWebhooks');
  const radioName = useId();
  const [name, setName] = useState('');
  const [auth, setAuth] = useState<IncomingWebhookAuth>('bearer');
  const [rate, setRate] = useState(String(INCOMING_WEBHOOK_DEFAULT_RATE_PER_SEC));
  const [openAck, setOpenAck] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // One key per form: a retry after a lost answer replays the same hook and secrets.
  const [key] = useState(idempotencyKey);
  const errors = draftErrors({ name, rate });
  const ackMissing = auth === 'none' && !openAck;
  const create = useMutation({
    mutationFn: () =>
      incomingWebhooksApi.create(
        baseId,
        { name: name.trim(), auth, rate_limit_per_sec: parseRate(rate) ?? undefined },
        key,
      ),
    onSuccess: onCreated,
  });
  const shown = submitted ? errors : {};
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      data-testid="hook-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (Object.keys(errors).length === 0 && !ackMissing) create.mutate();
      }}
    >
      <FormField
        label={t('form.name')}
        hint={t('form.nameHint')}
        error={shown.name === undefined ? undefined : t(`form.errors.${shown.name}`)}
      >
        {(control) => (
          <Input
            {...control}
            value={name}
            maxLength={MAX_INCOMING_WEBHOOK_NAME_LENGTH}
            autoComplete="off"
            data-testid="hook-name"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        )}
      </FormField>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-label text-fg">{t('create.auth')}</legend>
        {AUTH_CHOICES.map((choice) => (
          <label
            key={choice}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5',
              auth === choice ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
            )}
          >
            <input
              type="radio"
              name={radioName}
              value={choice}
              checked={auth === choice}
              data-testid={`hook-auth-${choice}`}
              className="mt-0.5 size-4 shrink-0"
              aria-describedby={`${radioName}-${choice}`}
              onChange={() => {
                setAuth(choice);
              }}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-body font-medium text-fg">
                {t(`auth.long.${choice}`)}
                {choice === 'bearer' ? (
                  <span className="ml-2 rounded-sm bg-surface px-1.5 py-0.5 text-label font-medium text-accent">
                    {t('create.recommended')}
                  </span>
                ) : null}
              </span>
              <span id={`${radioName}-${choice}`} className="text-label font-normal text-fg-muted">
                {t(`auth.explain.${choice}`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {auth === 'none' ? (
        <Note
          tone="warning"
          icon={<ShieldAlert />}
          title={t('auth.noneWarningTitle')}
          data-testid="hook-none-warning"
        >
          <p>{t('auth.noneWarning')}</p>
          <Checkbox
            className="mt-2"
            label={t('create.noneAck')}
            checked={openAck}
            aria-invalid={submitted && ackMissing}
            data-testid="hook-none-ack"
            onChange={(event) => {
              setOpenAck(event.target.checked);
            }}
          />
          {submitted && ackMissing ? (
            <p role="alert" className="mt-1 text-label font-normal text-danger">
              {t('form.errors.ack')}
            </p>
          ) : null}
        </Note>
      ) : null}
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
            data-testid="hook-rate"
            onChange={(event) => {
              setRate(event.target.value);
            }}
          />
        )}
      </FormField>
      {create.isError ? <ErrorAlert error={create.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending} data-testid="hook-create-submit">
          {create.isPending ? <Spinner /> : null}
          {t('create.submit')}
        </Button>
      </div>
    </form>
  );
}
