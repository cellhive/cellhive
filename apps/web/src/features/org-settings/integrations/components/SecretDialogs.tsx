import {
  SECRET_BASE_SCOPES,
  SECRET_ROTATION_OVERLAP_HOURS,
  type SecretDto,
  type SecretWithValueDto,
} from '@cellhive/contracts';
import { Button, Checkbox, Dialog, FormField, Input, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Info, KeyRound, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { isApiError } from '../../../../lib/api/client';
import { secretsApi } from '../../../../lib/api/secrets';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../../lib/errors/translate';
import { useFormatters } from '../../../../lib/i18n/format';
import { keys } from '../../../../lib/query/keys';
import { httpSecretsApi } from '../api';
import {
  HTTP_SECRET_KINDS,
  initialSecretForm,
  secretRequestOf,
  type SecretFormErrors,
  type SecretFormState,
} from '../model';

import { AllowedHostsInput } from './AllowedHostsInput';
import { CopyField, Note } from './parts';

/** Ways to set a signing secret's value: generated first (recommended). */
const NEW_MODES = ['generate', 'enter'] as const;
const EDIT_MODES = ['keep', 'generate', 'enter'] as const;

interface BaseName {
  readonly id: string;
  readonly name: string;
}

export interface SecretFormDialogProps {
  readonly orgId: string;
  /** `null`: closed; `'new'`: add; a secret: change it. */
  readonly state: 'new' | SecretDto | null;
  readonly bases: readonly BaseName[] | undefined;
  readonly onClose: () => void;
  /** `secret.value` is there when the server generated it (shown once by the caller). */
  readonly onSaved: (secret: SecretWithValueDto, created: boolean) => void;
}

/**
 * Add or change an HTTP secret (BACKLOG T613, CONTRACTS §24): its kind
 * (a header value, or a Standard Webhooks signing secret the server can
 * generate), a name the automation builders see, the value (write-only;
 * changing a secret keeps it unless replaced) and the bases it may be used in.
 */
export function SecretFormDialog({ orgId, state, bases, onClose, onSaved }: SecretFormDialogProps) {
  const { t } = useTranslation('orgIntegrations');
  const editing = state === null || state === 'new' ? null : state;
  return (
    <Dialog
      open={state !== null}
      layout="sheet"
      className="max-w-xl"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        editing === null
          ? t('secrets.form.addTitle')
          : t('secrets.form.editTitle', { name: editing.name })
      }
      description={t('secrets.form.description')}
      closeLabel={t('page.close')}
    >
      {state === null ? null : (
        <SecretForm
          key={editing?.id ?? 'new'}
          orgId={orgId}
          editing={editing}
          bases={bases}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function SecretForm({
  orgId,
  editing,
  bases,
  onClose,
  onSaved,
}: {
  readonly orgId: string;
  readonly editing: SecretDto | null;
  readonly bases: readonly BaseName[] | undefined;
  readonly onClose: () => void;
  readonly onSaved: SecretFormDialogProps['onSaved'];
}) {
  const { t, i18n } = useTranslation('orgIntegrations');
  const id = useId();
  const [form, setForm] = useState<SecretFormState>(() => initialSecretForm(editing));
  const [submitted, setSubmitted] = useState(false);
  const set = (patch: Partial<SecretFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };
  const request = secretRequestOf(form, editing);
  const errors: SecretFormErrors = request.ok ? {} : request.errors;
  const message = (key: keyof SecretFormErrors) =>
    submitted && errors[key] !== undefined
      ? t(`secrets.form.error.${errors[key]}` as 'secrets.form.error.required')
      : undefined;
  const save = useMutation({
    mutationFn: async () => {
      if (!request.ok) throw new Error('unreachable');
      if ('create' in request) return httpSecretsApi.create(orgId, request.create);
      if (editing === null || request.update === null) return null;
      return httpSecretsApi.update(editing.id, request.update);
    },
    onSuccess: (secret) => {
      if (secret === null) {
        onClose();
        return;
      }
      onSaved(secret, editing === null);
    },
  });
  const chosen = new Set(form.baseIds);
  const signing = form.kind === 'webhook_signing';
  // T701: the server's verdict on the allowed hosts goes under that field.
  const hostsProblem = isApiError(save.error)
    ? save.error.errors.find((item) => item.path.startsWith('allowed_hosts'))
    : undefined;
  const hostsError =
    message('allowed_hosts') ??
    (hostsProblem === undefined ? undefined : translateDetail(i18n, hostsProblem));
  const otherError =
    save.isError &&
    !(
      isApiError(save.error) &&
      save.error.errors.every((item) => item.path.startsWith('allowed_hosts')) &&
      save.error.errors.length > 0
    );

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      data-testid="secret-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (request.ok) save.mutate();
      }}
    >
      {editing === null ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-label text-fg">{t('secrets.form.kind')}</legend>
          {HTTP_SECRET_KINDS.map((kind) => (
            <label
              key={kind}
              className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
            >
              <input
                type="radio"
                name={`${id}-kind`}
                value={kind}
                checked={form.kind === kind}
                className="mt-0.5 size-4 shrink-0"
                data-testid={`secret-kind-${kind}`}
                onChange={() => {
                  set({
                    kind,
                    valueMode: kind === 'webhook_signing' ? 'generate' : 'enter',
                    value: '',
                  });
                }}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-body font-medium text-fg">{t(`secrets.kind.${kind}`)}</span>
                <span className="text-label font-normal text-fg-muted">
                  {t(`secrets.kindHint.${kind}`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <FormField
        label={t('secrets.form.name')}
        hint={t('secrets.form.nameHint')}
        error={message('name')}
      >
        {(control) => (
          <Input
            {...control}
            value={form.name}
            maxLength={100}
            autoComplete="off"
            data-testid="secret-name"
            onChange={(event) => {
              set({ name: event.target.value });
            }}
          />
        )}
      </FormField>

      {signing ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-label text-fg">{t('secrets.form.value')}</legend>
          {(editing === null ? NEW_MODES : EDIT_MODES).map((mode) => (
            <label
              key={mode}
              className="flex min-h-control items-center gap-2 text-body text-fg lg:min-h-0"
            >
              <input
                type="radio"
                name={`${id}-mode`}
                value={mode}
                checked={form.valueMode === mode}
                className="size-4"
                data-testid={`secret-mode-${mode}`}
                onChange={() => {
                  set({ valueMode: mode, value: '' });
                }}
              />
              {t(`secrets.form.mode.${mode}`)}
            </label>
          ))}
          {editing !== null && form.valueMode !== 'keep' ? (
            <span className="text-label font-normal text-fg-muted">
              {t('secrets.form.rotateHint', { hours: SECRET_ROTATION_OVERLAP_HOURS })}
            </span>
          ) : null}
        </fieldset>
      ) : editing !== null ? (
        <Checkbox
          label={t('secrets.form.replace')}
          checked={form.valueMode === 'enter'}
          data-testid="secret-replace"
          onChange={(event) => {
            set({ valueMode: event.target.checked ? 'enter' : 'keep', value: '' });
          }}
        />
      ) : null}

      {form.valueMode === 'enter' ? (
        <FormField
          label={signing ? t('secrets.form.signingValue') : t('secrets.form.headerValue')}
          hint={signing ? t('secrets.form.signingValueHint') : t('secrets.form.headerValueHint')}
          error={message('value')}
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              value={form.value}
              autoComplete="new-password"
              spellCheck={false}
              className="font-code"
              data-testid="secret-value"
              onChange={(event) => {
                set({ value: event.target.value });
              }}
            />
          )}
        </FormField>
      ) : null}

      <FormField
        label={t('secrets.form.allowedHosts')}
        hint={
          editing !== null && editing.allowed_hosts.length === 0
            ? t('secrets.form.allowedHostsLegacyHint')
            : t('secrets.form.allowedHostsHint')
        }
        error={hostsError}
      >
        {(control) => (
          <AllowedHostsInput
            control={control}
            hosts={form.allowedHosts}
            draft={form.hostDraft}
            onChange={(allowedHosts, hostDraft) => {
              set({ allowedHosts, hostDraft });
            }}
          />
        )}
      </FormField>
      <AllowedHostsRules />

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-label text-fg">{t('secrets.form.scope')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {SECRET_BASE_SCOPES.map((scope) => (
            <label
              key={scope}
              className="flex min-h-control items-center gap-2 text-body text-fg lg:min-h-0"
            >
              <input
                type="radio"
                name={`${id}-scope`}
                value={scope}
                checked={form.baseScope === scope}
                className="size-4"
                onChange={() => {
                  set({ baseScope: scope });
                }}
              />
              {t(`secrets.scope.${scope}`)}
            </label>
          ))}
        </div>
        {form.baseScope === 'selected' ? (
          <div
            role="group"
            aria-label={t('secrets.form.scopeBases')}
            className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border border-line bg-surface p-3"
          >
            {bases === undefined ? (
              <Spinner />
            ) : bases.length === 0 ? (
              <span className="text-label font-normal text-fg-muted">
                {t('secrets.form.noBases')}
              </span>
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
        <span className="text-label font-normal text-fg-muted">{t('secrets.form.scopeHint')}</span>
        {message('base_ids') === undefined ? null : (
          <span className="text-label font-normal text-danger">{message('base_ids')}</span>
        )}
      </fieldset>
      {otherError ? <ErrorAlert error={save.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {t('page.cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending} data-testid="secret-save">
          {save.isPending ? <Spinner /> : null}
          {editing === null ? t('secrets.form.add') : t('secrets.form.save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * How allowed hosts work (T717, CONTRACTS §24): exact host, `*.` = its
 * subdomains only, `:port`, no IP — and that the list does not open an
 * internal address or another port (the HTTP allowlist above does that).
 */
function AllowedHostsRules() {
  const { t } = useTranslation('orgIntegrations');
  return (
    <Note
      tone="neutral"
      icon={<Info />}
      title={t('hosts.rulesTitle')}
      data-testid="secret-allowed-hosts-rules"
    >
      <ul className="flex list-disc flex-col gap-0.5 pl-4">
        <li>{t('hosts.rules.exact')}</li>
        <li>{t('hosts.rules.wildcard')}</li>
        <li>{t('hosts.rules.port')}</li>
        <li>{t('hosts.rules.noIp')}</li>
        <li>{t('hosts.rules.notAllowlist')}</li>
      </ul>
    </Note>
  );
}

/** Why a value is shown once: after creating a secret, or after generating a new value. */
export interface RevealedSecret {
  readonly secret: SecretWithValueDto & { readonly value: string };
  readonly reason: 'created' | 'rotated';
}

/**
 * The generated `whsec_…` value, shown **once** (CONTRACTS §24): a warning,
 * the value with "Copy", and a required "I stored it" check before the dialog
 * closes (as the incoming webhook secrets, FRONTEND §16.1). The value lives
 * only in this component's props.
 */
export function SecretRevealDialog({
  reveal,
  onDone,
}: {
  readonly reveal: RevealedSecret | null;
  readonly onDone: () => void;
}) {
  if (reveal === null) return null;
  return (
    <RevealDialog
      key={`${reveal.secret.id}:${reveal.secret.updated_at}`}
      reveal={reveal}
      onDone={onDone}
    />
  );
}

function RevealDialog({
  reveal,
  onDone,
}: {
  readonly reveal: RevealedSecret;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('orgIntegrations');
  const format = useFormatters();
  const nagId = useId();
  const [saved, setSaved] = useState(false);
  const [nagged, setNagged] = useState(false);
  const checkbox = useRef<HTMLInputElement>(null);
  const finish = () => {
    if (saved) {
      onDone();
      return;
    }
    setNagged(true);
    checkbox.current?.focus();
  };
  const until = reveal.secret.previous_value_expires_at;
  return (
    <Dialog
      open
      layout="sheet"
      className="max-w-xl"
      preventDismiss
      onDismissBlocked={finish}
      onOpenChange={(open) => {
        // Only reached when the browser forces a close (Escape pressed repeatedly).
        if (!open) onDone();
      }}
      title={t(`secrets.reveal.title.${reveal.reason}`)}
      description={t('secrets.reveal.description', { name: reveal.secret.name })}
      closeLabel={t('page.close')}
    >
      <form
        className="flex flex-col gap-4"
        data-testid="secret-reveal"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <Note tone="warning" icon={<TriangleAlert />} title={t('secrets.reveal.warningTitle')}>
          {t('secrets.reveal.warning')}
        </Note>
        <CopyField
          label={t('secrets.reveal.label')}
          value={reveal.secret.value}
          hint={
            reveal.reason === 'rotated' && until !== null
              ? t('secrets.reveal.rotated', { date: format.dateTime(until) })
              : t('secrets.reveal.hint')
          }
          data-testid="secret-reveal-value"
        />
        <div className="flex flex-col gap-1">
          <Checkbox
            ref={checkbox}
            label={t('secrets.reveal.confirm')}
            checked={saved}
            aria-invalid={nagged && !saved}
            aria-describedby={nagged && !saved ? nagId : undefined}
            data-testid="secret-reveal-confirm"
            onChange={(event) => {
              setSaved(event.target.checked);
            }}
          />
          {nagged && !saved ? (
            <p id={nagId} role="alert" className="text-label font-normal text-danger">
              {t('secrets.reveal.nag')}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button type="submit" data-testid="secret-reveal-done">
            {t('secrets.reveal.done')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Generate a new value for a signing secret (CONTRACTS §24): the previous
 * value keeps signing for 24 hours, the new one is shown once.
 */
export function RotateSecretDialog({
  secret,
  onClose,
  onRotated,
}: {
  readonly secret: SecretDto | null;
  readonly onClose: () => void;
  readonly onRotated: (secret: SecretWithValueDto) => void;
}) {
  const { t } = useTranslation('orgIntegrations');
  const rotate = useMutation({
    mutationFn: (target: SecretDto) => httpSecretsApi.update(target.id, { generate: true }),
    onSuccess: onRotated,
  });
  return (
    <Dialog
      open={secret !== null}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) {
          rotate.reset();
          onClose();
        }
      }}
      title={secret === null ? '' : t('secrets.rotate.title', { name: secret.name })}
      description={t('secrets.rotate.description', { hours: SECRET_ROTATION_OVERLAP_HOURS })}
      closeLabel={t('page.close')}
    >
      {secret === null ? null : (
        <div className="flex flex-col gap-4" data-testid="secret-rotate">
          {secret.previous_value_expires_at === null ? null : (
            <Note tone="warning" icon={<KeyRound />}>
              {t('secrets.rotate.again')}
            </Note>
          )}
          {rotate.isError ? <ErrorAlert error={rotate.error} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('page.cancel')}
            </Button>
            <Button
              disabled={rotate.isPending}
              data-testid="secret-rotate-confirm"
              onClick={() => {
                // The generated value goes to the caller once; the mutation forgets it.
                rotate.mutate(secret, {
                  onSettled: (_data, error) => {
                    if (error === null) rotate.reset();
                  },
                });
              }}
            >
              {rotate.isPending ? <Spinner /> : null}
              {t('secrets.rotate.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Delete a secret: automations still using it are listed (names only when
 * the caller sees them) and the server refuses while they do (`409
 * SECRET_IN_USE`).
 */
export function DeleteSecretDialog({
  orgId,
  secret,
  onClose,
  onDeleted,
}: {
  readonly orgId: string;
  readonly secret: SecretDto | null;
  readonly onClose: () => void;
  readonly onDeleted: (secret: SecretDto) => void;
}) {
  const { t } = useTranslation('orgIntegrations');
  const usages = useQuery({
    queryKey: keys.secretUsages(orgId, secret?.id ?? ''),
    queryFn: ({ signal }) => secretsApi.usages(secret?.id ?? '', signal),
    enabled: secret !== null,
  });
  const remove = useMutation({
    mutationFn: (target: SecretDto) => secretsApi.remove(target.id),
    onSuccess: (_result, target) => {
      onDeleted(target);
    },
    onError: () => {
      void usages.refetch();
    },
  });
  const items = usages.data?.items.filter((item) => item.kind === 'automation') ?? [];
  const inUse = (usages.data?.total ?? 0) > 0;
  return (
    <Dialog
      open={secret !== null}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) {
          remove.reset();
          onClose();
        }
      }}
      title={secret === null ? '' : t('secrets.delete.title', { name: secret.name })}
      description={t('secrets.delete.description')}
      closeLabel={t('page.close')}
    >
      {secret === null ? null : (
        <div className="flex flex-col gap-4" data-testid="secret-delete">
          {usages.isPending ? (
            <div role="status" aria-busy="true" aria-label={t('secrets.delete.loadingUsages')}>
              <Skeleton className="h-12" />
            </div>
          ) : !inUse ? (
            <p className="text-body text-fg-muted">{t('secrets.delete.noUsages')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-body text-fg">
                {t('secrets.delete.usages', { count: usages.data?.total ?? 0 })}
              </p>
              <ul className="flex flex-col gap-1">
                {items.map((usage) => (
                  <li
                    key={usage.automation_id}
                    className="flex flex-wrap items-center gap-2 text-body"
                  >
                    {usage.name === null ? (
                      <span className="text-fg-muted">{t('secrets.delete.hiddenAutomation')}</span>
                    ) : (
                      <span className="text-fg">{usage.name}</span>
                    )}
                    <Link
                      to={`/b/${encodeURIComponent(usage.base_id)}/automations/${encodeURIComponent(usage.automation_id)}`}
                      className="text-label text-accent underline"
                    >
                      {t('secrets.delete.open')}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {remove.isError ? <ErrorAlert error={remove.error} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('page.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending || inUse || usages.isPending}
              data-testid="secret-delete-confirm"
              onClick={() => {
                remove.mutate(secret);
              }}
            >
              {remove.isPending ? <Spinner /> : null}
              {t('secrets.delete.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
