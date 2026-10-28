import { changePasswordRequestSchema, PASSWORD_MIN_LENGTH } from '@cellhive/contracts';
import { Button, Checkbox, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { useId } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import {
  applyServerErrors,
  submitWith,
  useFieldErrorText,
  zodResolver,
} from '../../../lib/forms/zod-form';
import { showToast } from '../../../lib/toast/toast';

import { profileApi } from './api';
import { SECTION_CLASSES } from './ProfileSection';

/** Fields the server can point at (`errors[].path`), shown under the field. */
const FIELDS = ['current_password', 'new_password'] as const;

const passwordFormSchema = changePasswordRequestSchema
  .extend({ confirm_password: z.string() })
  .refine((value) => value.new_password === value.confirm_password, {
    path: ['confirm_password'],
    params: { code: 'PASSWORD_MISMATCH' },
  });
type PasswordForm = z.input<typeof passwordFormSchema>;

const EMPTY: PasswordForm = {
  current_password: '',
  new_password: '',
  confirm_password: '',
  revoke_tokens: false,
};

/**
 * "Password" of the account page (T831): `POST /me/password`. Other
 * devices are always signed out (this one stays); revoking API tokens is
 * a choice, off by default (CONTRACTS §12.0).
 */
export function PasswordSection() {
  const { t } = useTranslation('account');
  const heading = useId();
  const fieldError = useFieldErrorText();
  const form = useForm<PasswordForm>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: EMPTY,
  });
  const errors = form.formState.errors;
  const mutation = useMutation({
    mutationFn: (values: PasswordForm) =>
      profileApi.changePassword({
        current_password: values.current_password,
        new_password: values.new_password,
        revoke_tokens: values.revoke_tokens,
      }),
    onSuccess: () => {
      form.reset(EMPTY);
      showToast({ variant: 'success', message: t('password.changed') });
    },
    onError: (error) => {
      applyServerErrors(error, FIELDS, form.setError);
    },
  });
  return (
    <section aria-labelledby={heading} className={SECTION_CLASSES} data-testid="password-section">
      <div className="flex flex-col gap-1">
        <h2 id={heading} className="text-heading">
          {t('password.title')}
        </h2>
        <p className="text-fg-muted">{t('password.description')}</p>
      </div>
      <form
        noValidate
        className="flex flex-col gap-4"
        data-testid="password-form"
        onSubmit={submitWith(
          form.handleSubmit((values) => {
            mutation.mutate(values);
          }),
        )}
      >
        {mutation.isError ? <ErrorAlert error={mutation.error} hidePaths={FIELDS} /> : null}
        <FormField label={t('password.current')} error={fieldError(errors.current_password)}>
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="current-password"
              {...form.register('current_password')}
            />
          )}
        </FormField>
        <FormField
          label={t('password.new')}
          hint={t('password.newHint', { min: PASSWORD_MIN_LENGTH })}
          error={fieldError(errors.new_password)}
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              {...form.register('new_password')}
            />
          )}
        </FormField>
        <FormField label={t('password.confirm')} error={fieldError(errors.confirm_password)}>
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              {...form.register('confirm_password')}
            />
          )}
        </FormField>
        <Checkbox
          label={t('password.revokeTokens')}
          hint={t('password.revokeTokensHint')}
          {...form.register('revoke_tokens')}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {t('password.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
