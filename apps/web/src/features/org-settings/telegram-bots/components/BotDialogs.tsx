import {
  SECRET_BASE_SCOPES,
  TELEGRAM_BOT_TOKEN_PATTERN,
  type Id,
  type SecretBaseScope,
  type SecretDto,
  type TelegramDeliveryMode,
  type UpdateSecretRequest,
} from '@cellhive/contracts';
import { Alert, Button, Checkbox, Dialog, FormField, Input, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Lock, Zap } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { isApiError } from '../../../../lib/api/client';
import { secretsApi } from '../../../../lib/api/secrets';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { keys } from '../../../../lib/query/keys';

/** Fields of the form (keys of the client checks). */
const FIELD = { name: 'name', value: 'value', bases: 'base_ids' } as const;
/** The shape of a BotFather token, shown as an example (not translated). */
const TOKEN_EXAMPLE = '123456789:AAH…';

interface BaseName {
  readonly id: string;
  readonly name: string;
}

interface FormState {
  readonly name: string;
  readonly token: string;
  readonly baseScope: SecretBaseScope;
  readonly baseIds: readonly string[];
}

/** What the form would send, or the problems to show first (client checks). */
function requestOf(
  form: FormState,
  editing: SecretDto | null,
): { body: UpdateSecretRequest & { name: string }; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  const token = form.token.trim();
  if (name === '') errors['name'] = 'required';
  if (editing === null && token === '') errors['value'] = 'required';
  else if (token !== '' && !TELEGRAM_BOT_TOKEN_PATTERN.test(token)) errors['value'] = 'format';
  if (form.baseScope === 'selected' && form.baseIds.length === 0) errors['base_ids'] = 'bases';
  return {
    body: {
      name,
      ...(token === '' ? {} : { value: token }),
      base_scope: form.baseScope,
      base_ids: form.baseScope === 'selected' ? (form.baseIds as Id<'bse'>[]) : [],
    },
    errors,
  };
}

export interface BotFormDialogProps {
  readonly orgId: string;
  /** `null`: closed; `'new'`: add a bot; a bot: change it. */
  readonly state: 'new' | SecretDto | null;
  readonly bases: readonly BaseName[] | undefined;
  /** The organization's notification bot (T555): its token change is explained. */
  readonly notificationBotId?: string | null;
  /** How the notification bot receives updates (T614): another bot's token drops the webhook. */
  readonly notificationBotMode?: TelegramDeliveryMode | null;
  readonly onClose: () => void;
  readonly onSaved: (bot: SecretDto, created: boolean) => void;
}

/**
 * Add or change a Telegram bot (BACKLOG T516, CONTRACTS §24): a name the
 * automation builders see, the token (write-only — never shown again; left
 * empty when changing keeps it) and the bases it may be used in.
 */
export function BotFormDialog({
  orgId,
  state,
  bases,
  notificationBotId = null,
  notificationBotMode = null,
  onClose,
  onSaved,
}: BotFormDialogProps) {
  const { t } = useTranslation('telegramBots');
  const editing = state === null || state === 'new' ? null : state;
  return (
    <Dialog
      open={state !== null}
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editing === null ? t('form.addTitle') : t('form.editTitle', { name: editing.name })}
      description={t('form.description')}
      closeLabel={t('form.close')}
    >
      {state === null ? null : (
        <BotForm
          key={editing?.id ?? 'new'}
          orgId={orgId}
          editing={editing}
          bases={bases}
          notificationBot={editing !== null && editing.id === notificationBotId}
          webhookMode={notificationBotMode === 'webhook'}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function BotForm({
  orgId,
  editing,
  bases,
  notificationBot,
  webhookMode,
  onClose,
  onSaved,
}: Omit<BotFormDialogProps, 'state' | 'notificationBotId' | 'notificationBotMode'> & {
  readonly editing: SecretDto | null;
  readonly notificationBot: boolean;
  readonly webhookMode: boolean;
}) {
  const { t } = useTranslation('telegramBots');
  const scopeName = useId();
  const [form, setForm] = useState<FormState>({
    name: editing?.name ?? '',
    token: '',
    baseScope: editing?.base_scope ?? 'all',
    baseIds: editing?.base_ids ?? [],
  });
  const [submitted, setSubmitted] = useState(false);
  const set = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };
  const { body, errors } = requestOf(form, editing);
  const shown = submitted ? errors : {};
  const save = useMutation({
    mutationFn: () =>
      editing === null
        ? secretsApi.create(orgId, {
            kind: 'telegram_bot',
            name: body.name,
            value: body.value ?? '',
            base_scope: body.base_scope ?? 'all',
            base_ids: body.base_ids ?? [],
          })
        : secretsApi.update(editing.id, body),
    onSuccess: (bot) => {
      onSaved(bot, editing === null);
    },
  });
  const chosen = new Set(form.baseIds);
  const message = (field: string) =>
    shown[field] === undefined ? undefined : t(`form.errors.${shown[field]}`);

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (Object.keys(errors).length === 0) save.mutate();
      }}
    >
      <FormField label={t('form.name')} hint={t('form.nameHint')} error={message(FIELD.name)}>
        {(control) => (
          <Input
            {...control}
            value={form.name}
            maxLength={100}
            autoComplete="off"
            data-testid="bot-name"
            onChange={(event) => {
              set({ name: event.target.value });
            }}
          />
        )}
      </FormField>
      <FormField
        label={t('form.token')}
        hint={editing === null ? t('form.tokenHint') : t('form.tokenKeepHint')}
        error={message(FIELD.value)}
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            value={form.token}
            autoComplete="off"
            spellCheck={false}
            placeholder={editing === null ? TOKEN_EXAMPLE : t('form.tokenSaved')}
            data-testid="bot-token"
            onChange={(event) => {
              set({ token: event.target.value });
            }}
          />
        )}
      </FormField>
      {notificationBot ? (
        <p
          className="flex items-start gap-2 text-label font-normal text-fg-muted"
          data-testid="bot-notification-token-hint"
        >
          <Bell aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>
            {t('notificationBot.tokenHint')}
            {webhookMode ? ` ${t('notificationBot.mode.tokenHintWebhook')}` : null}
          </span>
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-label text-fg">{t('form.scope')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {SECRET_BASE_SCOPES.map((scope) => (
            <label
              key={scope}
              className="flex min-h-control items-center gap-2 text-body text-fg lg:min-h-0"
            >
              <input
                type="radio"
                name={scopeName}
                value={scope}
                checked={form.baseScope === scope}
                className="size-4"
                onChange={() => {
                  set({ baseScope: scope });
                }}
              />
              {t(`scope.${scope}`)}
            </label>
          ))}
        </div>
        {form.baseScope === 'selected' ? (
          <div
            role="group"
            aria-label={t('form.scopeBases')}
            className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border border-line bg-surface p-3"
          >
            {bases === undefined ? (
              <Spinner />
            ) : bases.length === 0 ? (
              <span className="text-label font-normal text-fg-muted">{t('form.noBases')}</span>
            ) : (
              bases.map((base) => (
                <Checkbox
                  key={base.id}
                  label={base.name}
                  checked={chosen.has(base.id)}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) next.add(base.id);
                    else next.delete(base.id);
                    set({ baseIds: [...next] });
                  }}
                />
              ))
            )}
          </div>
        ) : null}
        <span className="text-label font-normal text-fg-muted">{t('form.scopeHint')}</span>
        {message(FIELD.bases) === undefined ? null : (
          <span className="text-label font-normal text-danger">{message(FIELD.bases)}</span>
        )}
      </fieldset>
      {save.isError ? <ErrorAlert error={save.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('form.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending} data-testid="bot-save">
          {save.isPending ? <Spinner /> : null}
          {editing === null ? t('form.add') : t('form.save')}
        </Button>
      </div>
    </form>
  );
}

/** Automations using a bot (`GET /secrets/:id/usages`): names only when the caller sees them. */
function UsageList({ orgId, bot }: { readonly orgId: string; readonly bot: SecretDto }) {
  const { t } = useTranslation('telegramBots');
  const usages = useQuery({
    queryKey: keys.secretUsages(orgId, bot.id),
    queryFn: ({ signal }) => secretsApi.usages(bot.id, signal),
  });
  if (usages.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label={t('delete.loadingUsages')}>
        <Skeleton className="h-12" />
      </div>
    );
  }
  if (usages.isError) return <ErrorAlert error={usages.error} />;
  if (usages.data.total === 0) {
    return <p className="text-body text-fg-muted">{t('delete.noUsages')}</p>;
  }
  const automations = usages.data.items.filter((usage) => usage.kind === 'automation');
  const notificationBot = usages.data.items.some((usage) => usage.kind === 'notification_channel');
  return (
    <div className="flex flex-col gap-2">
      {notificationBot ? (
        <p
          className="flex items-start gap-2 text-body text-fg"
          data-testid="bot-notification-usage"
        >
          <Bell aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-muted" />
          {t('delete.notificationBot')}
        </p>
      ) : null}
      {automations.length === 0 ? null : (
        <>
          <p className="text-body text-fg">
            {t('delete.usages', { count: usages.data.total - (notificationBot ? 1 : 0) })}
          </p>
          <ul
            className="flex max-h-60 flex-col overflow-y-auto rounded-lg border border-line"
            data-testid="bot-usages"
          >
            {automations.map((usage) => (
              <li
                key={usage.automation_id}
                className="flex items-center gap-2 border-t border-line px-3 py-2 first:border-t-0"
              >
                {usage.name === null ? (
                  <>
                    <Lock aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
                    <span className="text-fg-muted">{t('delete.hiddenAutomation')}</span>
                  </>
                ) : (
                  <>
                    <Zap aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
                    <span className="min-w-0 font-medium break-words">{usage.name}</span>
                    <Link
                      to={`/b/${encodeURIComponent(usage.base_id)}/automations`}
                      className="ml-auto inline-flex min-h-6 items-center text-label text-accent underline-offset-4 hover:underline max-lg:min-h-control"
                    >
                      {t('delete.open')}
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * `409 SECRET_IN_USE` because the bot is the organization's notification
 * bot (its `usages` name a `notification_channel`, CONTRACTS §22.7), not
 * because automations use it: explained in its own words (T555).
 */
export function blocksAsNotificationBot(error: unknown): boolean {
  if (!isApiError(error) || error.code !== 'SECRET_IN_USE') return false;
  return error.errors.some((item) => {
    const usages = item.params?.['usages'];
    return (
      Array.isArray(usages) &&
      usages.some(
        (usage: unknown) =>
          typeof usage === 'object' &&
          usage !== null &&
          (usage as { kind?: unknown }).kind === 'notification_channel',
      )
    );
  });
}

export interface DeleteBotDialogProps {
  readonly orgId: string;
  readonly bot: SecretDto | null;
  /**
   * The organization's notification bot (T555): it cannot be deleted
   * (`409 SECRET_IN_USE`), so the dialog explains why and offers no delete.
   */
  readonly notificationBotId?: string | null;
  readonly onClose: () => void;
  readonly onDeleted: (bot: SecretDto) => void;
}

/**
 * Deleting a bot: the automations using it are listed first; the server
 * refuses while any does (`409 SECRET_IN_USE`, shown as the error).
 */
export function DeleteBotDialog({
  orgId,
  bot,
  notificationBotId = null,
  onClose,
  onDeleted,
}: DeleteBotDialogProps) {
  const { t } = useTranslation('telegramBots');
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (target: SecretDto) => secretsApi.remove(target.id),
    onSuccess: (_result, target) => {
      onDeleted(target);
    },
    onError: (error) => {
      // Another admin may just have made it the notification bot: show it.
      if (blocksAsNotificationBot(error)) {
        void queryClient.invalidateQueries({ queryKey: keys.orgNotificationChannels(orgId) });
      }
    },
  });
  return (
    <Dialog
      open={bot !== null}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) {
          remove.reset();
          onClose();
        }
      }}
      title={bot === null ? '' : t('delete.title', { name: bot.name })}
      description={t('delete.description')}
      closeLabel={t('form.close')}
    >
      {bot === null ? null : (
        <div className="flex flex-col gap-4">
          {bot.id === notificationBotId ? (
            <Alert variant="info" role="note" data-testid="bot-delete-blocked">
              <p className="font-medium">{t('delete.notificationBotBlockedTitle')}</p>
              <p className="text-fg-muted">{t('delete.notificationBotBlocked')}</p>
            </Alert>
          ) : (
            <UsageList orgId={orgId} bot={bot} />
          )}
          {remove.isError ? (
            blocksAsNotificationBot(remove.error) ? (
              <ErrorAlert
                error={remove.error}
                overrides={{ SECRET_IN_USE: 'telegramBots:delete.notificationBotBlocked' }}
                hidePaths={['']}
              />
            ) : (
              <ErrorAlert error={remove.error} />
            )
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('form.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending || bot.id === notificationBotId}
              data-testid="bot-delete-confirm"
              onClick={() => {
                remove.mutate(bot);
              }}
            >
              {remove.isPending ? <Spinner /> : null}
              {t('delete.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
