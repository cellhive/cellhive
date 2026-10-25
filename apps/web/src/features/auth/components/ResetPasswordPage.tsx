import { PASSWORD_MIN_LENGTH } from '@cellhive/contracts';
import { Button, Checkbox, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import {
  applyServerErrors,
  submitWith,
  useFieldErrorText,
  zodResolver,
} from '../../../lib/forms/zod-form';
import { authApi } from '../api';
import { resetPasswordFormSchema, type LoginNotice, type ResetPasswordForm } from '../forms';

import { AuthCard } from './AuthCard';

const FIELDS = ['password'] as const;

/**
 * `/reset/:token` (CONTRACTS §12.1): choose a new password from a one-time
 * link; "revoke all my API tokens" is on by default (T802).
 */
export function ResetPasswordPage() {
  const { t } = useTranslation('auth');
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const fieldError = useFieldErrorText();
  const form = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordFormSchema),
    defaultValues: { password: '', confirm_password: '', revoke_tokens: true },
  });
  const errors = form.formState.errors;
  const mutation = useMutation({
    mutationFn: (values: ResetPasswordForm) =>
      authApi.resetPassword(token, {
        password: values.password,
        revoke_tokens: values.revoke_tokens,
      }),
    onSuccess: () => {
      const state: LoginNotice = { notice: 'passwordReset' };
      void navigate('/login', { replace: true, state });
    },
    onError: (error) => {
      applyServerErrors(error, FIELDS, form.setError);
    },
  });

  // Wrong, used or expired link: one message for all (CONTRACTS §6).
  if (isApiError(mutation.error) && mutation.error.code === 'RESET_TOKEN_INVALID') {
    return (
      <AuthCard title={t('reset.invalidTitle')} description={t('reset.invalidDescription')}>
        <Link to="/login" className="text-accent underline-offset-4 hover:underline">
          {t('backToLogin')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t('reset.title')} description={t('reset.description')}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={submitWith(
          form.handleSubmit((values) => {
            mutation.mutate(values);
          }),
        )}
      >
        {mutation.isError ? <ErrorAlert error={mutation.error} hidePaths={FIELDS} /> : null}
        <FormField
          label={t('fields.newPassword')}
          hint={t('fields.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          error={fieldError(errors.password)}
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              autoFocus
              {...form.register('password')}
            />
          )}
        </FormField>
        <FormField label={t('fields.confirmPassword')} error={fieldError(errors.confirm_password)}>
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
          label={t('reset.revokeTokens')}
          hint={t('reset.revokeTokensHint')}
          {...form.register('revoke_tokens')}
        />
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : null}
          {t('reset.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}

export default ResetPasswordPage;
