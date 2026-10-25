import { Button, Checkbox, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { orgBasesQuery } from '../../../../lib/query/queries';
import { apiTokenKeys, apiTokensApi } from '../api';
import {
  createRequestOf,
  customDateRange,
  EXPIRY_CHOICES,
  expiryAt,
  expiryChoiceState,
  initialCreateForm,
  orderedScopes,
  presetOf,
  SCOPE_GROUPS,
  SCOPE_PRESETS,
  scopeKey,
  scopesOfPreset,
  type CreateFormErrors,
  type CreateTokenForm,
} from '../model';

import { Note } from './parts';

import type { RevealedToken } from './dialogs';
import type { ApiTokenScope, CreateApiTokenRequest } from '@cellhive/contracts';

/**
 * "New API token" (BACKLOG T714): name, scopes by group with presets, bases
 * (all / chosen), expiration (7, 30, 90 by default, 365 days, a custom date, or never
 * — never only when the policy allows; choices longer than the policy's
 * limit are disabled with the reason). The created token goes to
 * `onCreated` once; the mutation forgets it right away.
 */
export function CreateTokenDialog({
  orgId,
  open,
  maxLifetimeDays,
  onClose,
  onCreated,
}: {
  readonly orgId: string;
  readonly open: boolean;
  readonly maxLifetimeDays: number | null;
  readonly onClose: () => void;
  readonly onCreated: (token: RevealedToken) => void;
}) {
  const { t } = useTranslation('apiTokens');
  return (
    <Dialog
      open={open}
      layout="sheet"
      className="max-w-2xl md:max-h-[90dvh] md:overflow-y-auto"
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('create.title')}
      description={t('create.description')}
      closeLabel={t('page.close')}
    >
      {open ? (
        <CreateForm
          orgId={orgId}
          maxLifetimeDays={maxLifetimeDays}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  );
}

function CreateForm({
  orgId,
  maxLifetimeDays,
  onClose,
  onCreated,
}: {
  readonly orgId: string;
  readonly maxLifetimeDays: number | null;
  readonly onClose: () => void;
  readonly onCreated: (token: RevealedToken) => void;
}) {
  const { t } = useTranslation('apiTokens');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const ids = useId();
  const [form, setForm] = useState<CreateTokenForm>(() => initialCreateForm(maxLifetimeDays));
  const [errors, setErrors] = useState<CreateFormErrors>({});
  const [now] = useState(() => new Date());
  const bases = useQuery(orgBasesQuery(orgId));
  const range = customDateRange(maxLifetimeDays, now);
  const create = useMutation({
    mutationFn: ({ body, key }: { body: CreateApiTokenRequest; key: string }) =>
      apiTokensApi.create(orgId, body, key),
    onSettled: () => queryClient.invalidateQueries({ queryKey: apiTokenKeys.all(orgId) }),
  });
  const update = (patch: Partial<CreateTokenForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setErrors({});
    if (create.isError) create.reset();
  };
  const preset = presetOf(form.scopes);
  const expiresAt = expiryAt(form.expiry, maxLifetimeDays, now);
  const errorText = (field: keyof CreateFormErrors): string | undefined => {
    const error = errors[field];
    if (error === undefined) return undefined;
    if (field === 'expiry' && error === 'invalid') {
      return t('create.errors.expiryInvalid', {
        min: format.date(`${range.min}T12:00:00`),
        max: format.date(`${range.max}T12:00:00`),
      });
    }
    const suffix = error === 'required' ? 'Required' : 'Invalid';
    return t(`create.errors.${field}${suffix}`);
  };
  const toggleScope = (scope: ApiTokenScope, on: boolean) => {
    const next = new Set(form.scopes);
    if (on) next.add(scope);
    else next.delete(scope);
    update({ scopes: orderedScopes(next) });
  };
  const baseItems = useMemo(() => bases.data ?? [], [bases.data]);

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      data-testid="token-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        const result = createRequestOf(form, maxLifetimeDays, new Date());
        if (!result.ok) {
          setErrors(result.errors);
          const first = event.currentTarget.querySelector<HTMLElement>('[aria-invalid="true"]');
          first?.focus();
          return;
        }
        create.mutate(
          { body: result.request, key: `web-${crypto.randomUUID()}` },
          {
            onSuccess: (created) => {
              // The value goes to the caller once; the mutation cache forgets it.
              onCreated({ id: created.id, name: created.name, token: created.token });
              create.reset();
            },
          },
        );
      }}
    >
      <FormField label={t('create.name')} hint={t('create.nameHint')} error={errorText('name')}>
        {(control) => (
          <Input
            {...control}
            value={form.name}
            maxLength={100}
            autoComplete="off"
            data-testid="token-name-input"
            onChange={(event) => {
              update({ name: event.target.value });
            }}
          />
        )}
      </FormField>

      <fieldset className="flex flex-col gap-3" aria-describedby={`${ids}-access-hint`}>
        {/* A rendered legend is not a flex item: no gap after it, so no negative margin
            on the hint either (T720: the hint overlapped the legend). */}
        <legend className="mb-1 text-body font-medium text-fg">{t('create.access')}</legend>
        <p id={`${ids}-access-hint`} className="text-label font-normal text-fg-muted">
          {t('create.accessHint')}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {SCOPE_PRESETS.map((item) => (
            <Choice
              key={item}
              name={`${ids}-preset`}
              checked={preset === item}
              label={t(`create.preset.${item}`)}
              hint={t(`create.preset.${item}Hint`)}
              data-testid={`token-preset-${item}`}
              onSelect={() => {
                update({ scopes: scopesOfPreset(item) });
              }}
            />
          ))}
        </div>
        <div className="flex flex-col rounded-md border border-line" data-testid="token-scopes">
          {SCOPE_GROUPS.map((group) => (
            <fieldset
              key={group.key}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2.5 first:border-t-0"
            >
              <legend className="sr-only">{t(`create.groups.${group.key}`)}</legend>
              <div className="flex min-w-0 flex-1 basis-48 flex-col" aria-hidden="true">
                <span className="text-body font-medium text-fg">
                  {t(`create.groups.${group.key}`)}
                </span>
                <span className="text-label font-normal text-fg-muted">
                  {t(`create.groups.${group.key}Hint`)}
                </span>
              </div>
              <div className="flex shrink-0 gap-4">
                {group.scopes.map((scope) => (
                  <Checkbox
                    key={scope}
                    label={
                      <>
                        <span aria-hidden="true">
                          {t(scope.endsWith(':read') ? 'create.read' : 'create.write')}
                        </span>
                        <span className="sr-only">{t(scopeKey(scope))}</span>
                      </>
                    }
                    checked={form.scopes.includes(scope)}
                    aria-invalid={errors.scopes !== undefined}
                    data-testid={`token-scope-${scope}`}
                    onChange={(event) => {
                      toggleScope(scope, event.target.checked);
                    }}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        {errors.scopes === undefined ? null : (
          <p role="alert" className="text-label font-normal text-danger">
            {errorText('scopes')}
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body font-medium text-fg">{t('create.bases')}</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Choice
            name={`${ids}-bases`}
            checked={form.allBases}
            label={t('create.allBases')}
            data-testid="token-bases-all"
            onSelect={() => {
              update({ allBases: true });
            }}
          />
          <Choice
            name={`${ids}-bases`}
            checked={!form.allBases}
            label={t('create.someBases')}
            data-testid="token-bases-some"
            onSelect={() => {
              update({ allBases: false });
            }}
          />
        </div>
        {form.allBases ? null : bases.isPending ? (
          <p className="text-label text-fg-muted">{t('page.loading')}</p>
        ) : bases.isError ? (
          <ErrorAlert error={bases.error} />
        ) : baseItems.length === 0 ? (
          <p className="text-label text-fg-muted">{t('create.noBases')}</p>
        ) : (
          <fieldset
            className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border border-line p-3"
            data-testid="token-base-list"
          >
            <legend className="sr-only">{t('create.basesLegend')}</legend>
            {baseItems.map((base) => (
              <Checkbox
                key={base.id}
                label={base.name}
                checked={form.baseIds.includes(base.id)}
                aria-invalid={errors.bases !== undefined}
                onChange={(event) => {
                  const id = base.id;
                  update({
                    baseIds: event.target.checked
                      ? [...form.baseIds, id]
                      : form.baseIds.filter((item) => item !== id),
                  });
                }}
              />
            ))}
          </fieldset>
        )}
        {errors.bases === undefined ? null : (
          <p role="alert" className="text-label font-normal text-danger">
            {errorText('bases')}
          </p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body font-medium text-fg">{t('create.expiry')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {EXPIRY_CHOICES.map((choice) => {
            const state = expiryChoiceState(choice, maxLifetimeDays);
            return (
              <Choice
                key={choice}
                name={`${ids}-expiry`}
                checked={form.expiry.choice === choice}
                disabled={state.disabled}
                label={t(`create.expiryChoice.${choice}`)}
                hint={
                  state.reason === null
                    ? undefined
                    : t(`create.${state.reason}`, { days: maxLifetimeDays })
                }
                data-testid={`token-expiry-${choice}`}
                onSelect={() => {
                  update({ expiry: { ...form.expiry, choice: choice } });
                }}
              />
            );
          })}
        </div>
        {form.expiry.choice === 'custom' ? (
          <FormField label={t('create.customDate')} error={errorText('expiry')}>
            {(control) => (
              <Input
                {...control}
                type="date"
                min={range.min}
                max={range.max}
                value={form.expiry.customDate}
                className="w-fit"
                data-testid="token-expiry-date"
                onChange={(event) => {
                  update({ expiry: { choice: 'custom', customDate: event.target.value } });
                }}
              />
            )}
          </FormField>
        ) : null}
        {form.expiry.choice === 'none' ? (
          <Note tone="warning" icon={<TriangleAlert />} data-testid="token-expiry-none-warning">
            {t('create.noneWarning')}
          </Note>
        ) : null}
        {expiresAt === undefined || expiresAt === null ? null : (
          <p className="text-label font-normal text-fg-muted" data-testid="token-expires-on">
            {t('create.expiresOn', { date: format.dateTime(expiresAt) })}
          </p>
        )}
      </fieldset>

      {create.isError ? <ErrorAlert error={create.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('page.cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending} data-testid="token-create-submit">
          {create.isPending ? <Spinner /> : null}
          {t('create.submit')}
        </Button>
      </div>
    </form>
  );
}

/** A native radio with its label and an optional hint (the policy reason of a disabled one). */
function Choice({
  name,
  checked,
  disabled = false,
  label,
  hint,
  onSelect,
  'data-testid': testId,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly onSelect: () => void;
  readonly 'data-testid'?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        data-testid={testId}
        onChange={onSelect}
        className="mt-0.5 size-4 shrink-0 accent-accent disabled:cursor-not-allowed"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-body text-fg">
          {label}
        </label>
        {hint === undefined ? null : (
          <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
