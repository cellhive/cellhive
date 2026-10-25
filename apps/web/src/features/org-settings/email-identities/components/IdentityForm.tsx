import {
  EMAIL_IDENTITY_BASE_SCOPES,
  EMAIL_IDENTITY_SMTP_PORTS,
  SMTP_SECURITY_MODES,
  type EmailIdentityDto,
  type EmailIdentityMutation,
  type EmailIdentityTransport,
  type EmailSettingsDto,
} from '@cellhive/contracts';
import { Button, Checkbox, cn, FormField, Input, Select, Spinner } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, Mail, Server } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../../lib/errors/translate';
import { emailIdentitiesApi, emailIdentityUsagesQuery } from '../api';
import { useIdentityCache } from '../hooks';
import {
  checkForm,
  createRequest,
  DEFAULT_PORT,
  displayNameIssue,
  hasErrors,
  initialForm,
  keepsStoredPassword,
  needsReverification,
  SERVER_PATHS,
  updateRequest,
  type FormErrors,
  type IdentityFormState,
} from '../model/form';
import { domainOf, previewSender } from '../model/sender';

import { Note } from './parts';
import { SignatureEditor } from './SignatureEditor';

/** Two radio cards: the instance SMTP or the identity's own server (ADR-33 §1A). */
function TransportChoice({
  value,
  onChange,
}: {
  readonly value: EmailIdentityTransport;
  readonly onChange: (value: EmailIdentityTransport) => void;
}) {
  const { t } = useTranslation('emailIdentities');
  const name = useId();
  const options: { value: EmailIdentityTransport; icon: typeof Mail }[] = [
    { value: 'system', icon: Mail },
    { value: 'smtp', icon: Server },
  ];
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-label text-fg">{t('form.transport')}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const id = `${name}-${option.value}`;
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border bg-surface p-3',
                checked ? 'border-accent bg-accent-soft' : 'border-line-control',
              )}
            >
              <input
                id={id}
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                className="mt-0.5 size-4 shrink-0"
                aria-describedby={`${id}-hint`}
                onChange={() => {
                  onChange(option.value);
                }}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-body font-medium text-fg">
                  <option.icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                  {t(`transport.${option.value}`)}
                </span>
                <span id={`${id}-hint`} className="text-label font-normal text-fg-muted">
                  {t(`transport.${option.value}Hint`)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function SecurityChoice({
  value,
  onChange,
}: {
  readonly value: IdentityFormState['security'];
  readonly onChange: (value: IdentityFormState['security']) => void;
}) {
  const { t } = useTranslation('emailIdentities');
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-label text-fg">{t('smtp.security')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {SMTP_SECURITY_MODES.map((mode) => (
          <label
            key={mode}
            className="flex min-h-control items-center gap-2 text-body text-fg lg:min-h-0"
          >
            <input
              type="radio"
              name={name}
              value={mode}
              checked={value === mode}
              className="size-4"
              onChange={() => {
                onChange(mode);
              }}
            />
            {t(`smtp.securityMode.${mode}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SmtpFields({
  identity,
  form,
  errors,
  set,
}: {
  readonly identity: EmailIdentityDto | null;
  readonly form: IdentityFormState;
  readonly errors: Readonly<Record<string, string | undefined>>;
  readonly set: (patch: Partial<IdentityFormState>) => void;
}) {
  const { t } = useTranslation('emailIdentities');
  const keep = keepsStoredPassword(identity, form);
  const domain = domainOf(form.email) ?? t('smtp.yourDomain');
  return (
    <section
      aria-labelledby="smtp-section-title"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface-sunken p-3"
    >
      <h3 id="smtp-section-title" className="text-body font-semibold">
        {t('smtp.title')}
      </h3>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <FormField label={t('smtp.host')} error={errors['host']} hint={t('smtp.hostHint')}>
          {(control) => (
            <Input
              {...control}
              value={form.host}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('smtp.hostPlaceholder')}
              onChange={(event) => {
                set({ host: event.target.value });
              }}
            />
          )}
        </FormField>
        <FormField label={t('smtp.port')}>
          {(control) => (
            <Select
              {...control}
              value={String(form.port)}
              onChange={(event) => {
                const port = EMAIL_IDENTITY_SMTP_PORTS.find(
                  (item) => String(item) === event.target.value,
                );
                if (port !== undefined) set({ port });
              }}
            >
              {EMAIL_IDENTITY_SMTP_PORTS.map((port) => (
                <option key={port} value={port}>
                  {port}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      <SecurityChoice
        value={form.security}
        onChange={(security) => {
          // Follow the usual port of the new mode while the port is still a default one.
          const usual = Object.values(DEFAULT_PORT).includes(form.port);
          set({
            security,
            ...(usual ? { port: DEFAULT_PORT[security] } : {}),
            allowInsecure: security === 'none' ? form.allowInsecure : false,
          });
        }}
      />
      {form.security === 'none' ? (
        <Note tone="danger" title={t('smtp.insecureTitle')} data-testid="smtp-insecure">
          <span>{t('smtp.insecure')}</span>
          <Checkbox
            label={t('smtp.insecureConfirm')}
            checked={form.allowInsecure}
            aria-invalid={errors['allowInsecure'] !== undefined}
            onChange={(event) => {
              set({ allowInsecure: event.target.checked });
            }}
          />
          {errors['allowInsecure'] === undefined ? null : (
            <span className="text-danger">{errors['allowInsecure']}</span>
          )}
        </Note>
      ) : null}
      <FormField label={t('smtp.username')} error={errors['username']}>
        {(control) => (
          <Input
            {...control}
            value={form.username}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              set({ username: event.target.value });
            }}
          />
        )}
      </FormField>
      {keep ? (
        <div className="flex flex-col gap-1">
          <span className="text-label text-fg">{t('smtp.password')}</span>
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="inline-flex items-center gap-1.5 text-body text-fg-muted"
              data-testid="smtp-password-saved"
            >
              <KeyRound aria-hidden="true" className="size-4 shrink-0" />
              {t('smtp.passwordSaved')}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="max-lg:h-control"
              onClick={() => {
                set({ changePassword: true, password: '' });
              }}
            >
              {t('smtp.changePassword')}
            </Button>
          </div>
        </div>
      ) : (
        <FormField
          label={t('smtp.password')}
          error={errors['password']}
          hint={identity?.smtp == null ? t('smtp.passwordHint') : t('smtp.passwordNewHint')}
        >
          {(control) => (
            <div className="flex flex-col gap-1.5">
              <Input
                {...control}
                type="password"
                value={form.password}
                autoComplete="new-password"
                data-testid="smtp-password"
                onChange={(event) => {
                  set({ password: event.target.value });
                }}
              />
              {identity?.smtp != null && form.transport === identity.transport ? (
                <Button
                  variant="link"
                  size="sm"
                  className="w-fit text-label"
                  onClick={() => {
                    set({ changePassword: false, password: '' });
                  }}
                >
                  {t('smtp.keepPassword')}
                </Button>
              ) : null}
            </div>
          )}
        </FormField>
      )}
      <Note tone="info" title={t('smtp.spfTitle')}>
        {t('smtp.spf', { domain })}
      </Note>
      <Note tone="info" title={t('smtp.basicAuthTitle')}>
        {t('smtp.basicAuth')}
      </Note>
    </section>
  );
}

const BASE_SCOPES = EMAIL_IDENTITY_BASE_SCOPES;

function BaseScope({
  form,
  bases,
  error,
  set,
}: {
  readonly form: IdentityFormState;
  readonly bases: readonly { id: string; name: string }[] | undefined;
  readonly error: string | undefined;
  readonly set: (patch: Partial<IdentityFormState>) => void;
}) {
  const { t } = useTranslation('emailIdentities');
  const name = useId();
  const chosen = new Set(form.baseIds);
  // Bases of the scope the caller cannot see any more stay chosen (and listed).
  const missing = form.baseIds.filter(
    (baseId) => !(bases ?? []).some((base) => base.id === baseId),
  );
  return (
    <fieldset
      className="flex flex-col gap-1.5"
      aria-describedby={error === undefined ? undefined : `${name}-error`}
    >
      <legend className="mb-1.5 text-label text-fg">{t('form.scope')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {BASE_SCOPES.map((scope) => (
          <label
            key={scope}
            className="flex min-h-control items-center gap-2 text-body text-fg lg:min-h-0"
          >
            <input
              type="radio"
              name={name}
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
          ) : bases.length === 0 && missing.length === 0 ? (
            <span className="text-label font-normal text-fg-muted">{t('form.noBases')}</span>
          ) : (
            [...bases, ...missing.map((id) => ({ id, name: t('scope.unknownBase') }))].map(
              (base) => (
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
              ),
            )
          )}
        </div>
      ) : null}
      <span className="text-label font-normal text-fg-muted">{t('form.scopeHint')}</span>
      {error === undefined ? null : (
        <span id={`${name}-error`} className="text-label font-normal text-danger">
          {error}
        </span>
      )}
    </fieldset>
  );
}

/** "Recipients will see": the mode the server will compute, live as the address is typed. */
function SenderPreviewNote({
  form,
  settings,
  orgLocale,
}: {
  readonly form: IdentityFormState;
  readonly settings: EmailSettingsDto | undefined;
  readonly orgLocale: string | null;
}) {
  const { t } = useTranslation('emailIdentities');
  const preview = previewSender(
    {
      email: form.email,
      displayName: form.displayName,
      replyTo: form.replyTo,
      transport: form.transport,
    },
    settings?.smtp,
    orgLocale,
  );
  if (preview === null) return null;
  const domain = domainOf(form.email) ?? '';
  const why =
    form.transport === 'smtp'
      ? t('preview.whySmtp')
      : settings?.smtp.configured !== true
        ? t('preview.whyNoSmtp')
        : preview.mode === 'send_as'
          ? t('preview.whySendAs', { domain })
          : t('preview.whyOnBehalf', { domain });
  return (
    <Note
      tone={preview.mode === 'send_as' ? 'info' : 'warning'}
      role="status"
      title={t(`mode.${preview.mode}`)}
      data-testid="sender-preview"
    >
      <span>{why}</span>
      <span>
        {t('preview.from', { from: preview.from ?? t('preview.systemAddress') })}
        {preview.replyTo === null ? null : (
          <>
            <br />
            {t('preview.replyTo', { replyTo: preview.replyTo })}
          </>
        )}
      </span>
    </Note>
  );
}

export interface IdentityFormProps {
  readonly orgId: string;
  /** `null`: a new identity. */
  readonly identity: EmailIdentityDto | null;
  readonly settings: EmailSettingsDto | undefined;
  readonly orgLocale: string | null;
  readonly bases: readonly { id: string; name: string }[] | undefined;
  readonly onSaved: (result: EmailIdentityMutation) => void;
  readonly onCancel: () => void;
  /** Renders the action buttons where the drawer wants them (its sticky footer). */
  readonly footer: (actions: ReactNode) => ReactNode;
  /** (T556) Opened by "Fix display name": the field gets the focus. */
  readonly focusDisplayName?: boolean;
}

/**
 * Add/edit form of a sender identity (board "S5 · Email identities - thêm
 * danh tính", completed with the own SMTP server of ADR-33 §1A).
 */
export function IdentityForm({
  orgId,
  identity,
  settings,
  orgLocale,
  bases,
  onSaved,
  onCancel,
  footer,
  focusDisplayName = false,
}: IdentityFormProps) {
  const { t, i18n } = useTranslation(['emailIdentities', 'errors']);
  const [form, setForm] = useState(() => initialForm(identity));
  const [submitted, setSubmitted] = useState(false);
  const cache = useIdentityCache(orgId);
  const formId = useId();
  const imageTarget = useMemo(() => ({ kind: 'org' as const, orgId }), [orgId]);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusDisplayName) return;
    // After the drawer's own focus (`showModal` runs in the parent's effect).
    const timer = window.setTimeout(() => {
      nameInput.current?.focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [focusDisplayName]);
  const set = (patch: Partial<IdentityFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };
  const usages = useQuery({
    ...emailIdentityUsagesQuery(orgId, identity?.id ?? ''),
    enabled: identity !== null,
  });
  const save = useMutation({
    mutationFn: async () => {
      if (identity === null) return emailIdentitiesApi.create(orgId, createRequest(form));
      const body = updateRequest(identity, form);
      if (Object.keys(body).length === 0) return { identity, verification: null };
      return emailIdentitiesApi.update(identity.id, body);
    },
    onSuccess: (result) => {
      cache.put(result.identity);
      onSaved(result);
    },
  });

  const clientErrors = checkForm(identity, form);
  const serverErrors = useMemo(() => {
    const result: Record<string, string> = {};
    if (!isApiError(save.error)) return result;
    for (const item of save.error.errors) {
      const field = SERVER_PATHS[item.path];
      if (field !== undefined && result[field] === undefined) {
        result[field] = translateDetail(i18n, item);
      }
    }
    return result;
  }, [save.error, i18n]);
  const shown: Record<string, string | undefined> = { ...serverErrors };
  if (submitted) {
    for (const [field, key] of Object.entries(clientErrors) as [keyof FormErrors, string][]) {
      if (key !== 'notAllowed') shown[field] = t(`form.errors.${key}`);
    }
  }
  // T556 (QA S5 M7): a name the server would refuse says why as it is typed,
  // one message per reason — also a stored name saved before the rule.
  const nameIssue = displayNameIssue(form);
  if (nameIssue !== null && shown['displayName'] === undefined) {
    shown['displayName'] = t('errors:detail.DISPLAY_NAME_NOT_ALLOWED', { context: nameIssue });
  }
  const reverify = identity !== null && needsReverification(identity, form);
  const usageTotal = usages.data?.total ?? 0;
  const handledPaths = Object.keys(SERVER_PATHS);

  const submitLabel =
    identity === null || reverify
      ? form.transport === 'smtp'
        ? t('form.saveAndTest')
        : t('form.saveAndSend')
      : t('form.save');

  return (
    <>
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (hasErrors(clientErrors, form) || save.isPending) return;
          save.mutate();
        }}
      >
        {identity?.display_name_issue == null ? null : (
          <Note tone="warning" title={t('nameIssue.title')} data-testid="display-name-issue-note">
            {t('nameIssue.body')}
          </Note>
        )}
        <FormField label={t('form.email')} error={shown['email']}>
          {(control) => (
            <Input
              {...control}
              type="email"
              value={form.email}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('form.emailPlaceholder')}
              onChange={(event) => {
                set({ email: event.target.value });
              }}
            />
          )}
        </FormField>
        <FormField
          label={t('form.displayName')}
          error={shown['displayName']}
          hint={t('form.displayNameHint')}
        >
          {(control) => (
            <Input
              {...control}
              ref={nameInput}
              value={form.displayName}
              autoComplete="off"
              onChange={(event) => {
                set({ displayName: event.target.value });
              }}
            />
          )}
        </FormField>
        <TransportChoice
          value={form.transport}
          onChange={(transport) => {
            set({ transport });
          }}
        />
        {form.transport === 'smtp' ? (
          <SmtpFields identity={identity} form={form} errors={shown} set={set} />
        ) : null}
        <SenderPreviewNote form={form} settings={settings} orgLocale={orgLocale} />
        {reverify ? (
          <Note tone="warning" title={t('form.reverifyTitle')} data-testid="reverify-warning">
            {t('form.reverify', { count: usageTotal, name: identity.display_name })}
          </Note>
        ) : null}
        <FormField label={t('form.replyTo')} error={shown['replyTo']} hint={t('form.replyToHint')}>
          {(control) => (
            <Input
              {...control}
              type="email"
              value={form.replyTo}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                set({ replyTo: event.target.value });
              }}
            />
          )}
        </FormField>
        <BaseScope form={form} bases={bases} error={shown['baseIds']} set={set} />
        <SignatureEditor
          value={form.signature}
          serverError={serverErrors['signature']}
          imageTarget={imageTarget}
          onChange={(signature) => {
            set({ signature });
          }}
        />
        {save.isError ? <ErrorAlert error={save.error} hidePaths={handledPaths} /> : null}
      </form>
      {footer(
        <div className="flex flex-col gap-2">
          <p className="text-label font-normal text-fg-muted">
            {identity !== null && !reverify
              ? t('form.footnoteEdit')
              : form.transport === 'smtp'
                ? t('form.footnoteSmtp')
                : t('form.footnote')}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onCancel}>
              {t('form.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              disabled={save.isPending}
              data-testid="identity-save"
            >
              {save.isPending ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </div>
        </div>,
      )}
    </>
  );
}
