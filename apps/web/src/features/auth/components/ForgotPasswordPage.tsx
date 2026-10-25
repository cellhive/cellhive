import { forgotPasswordRequestSchema, type ForgotPasswordRequest } from '@cellhive/contracts';
import { Alert, Button, FormField, Input, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { submitWith, useFieldErrorText, zodResolver } from '../../../lib/forms/zod-form';
import { setupStatusQuery } from '../../../lib/session/session';
import { authApi } from '../api';

import { AuthCard } from './AuthCard';

function BackToLogin() {
  const { t } = useTranslation('auth');
  return (
    <Link to="/login" className="text-accent underline-offset-4 hover:underline">
      {t('backToLogin')}
    </Link>
  );
}

/**
 * `/forgot-password` (SPEC §14.2). Without SMTP the server sends nothing,
 * so the screen explains how to get a link from an administrator instead.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation('auth');
  const setup = useQuery(setupStatusQuery());
  const fieldError = useFieldErrorText();
  const form = useForm<ForgotPasswordRequest>({
    resolver: zodResolver(forgotPasswordRequestSchema),
    defaultValues: { email: '' },
  });
  const mutation = useMutation({ mutationFn: authApi.forgotPassword });

  if (setup.isPending) {
    return <Skeleton className="h-48" />;
  }
  if (setup.data?.auth_config.smtp_enabled !== true) {
    return (
      <AuthCard title={t('forgot.title')} description={t('forgot.noEmail')}>
        <BackToLogin />
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t('forgot.title')} description={t('forgot.description')}>
      {mutation.isSuccess ? (
        <Alert variant="success">{t('forgot.sent', { email: mutation.variables.email })}</Alert>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={submitWith(
            form.handleSubmit((values) => {
              mutation.mutate(values);
            }),
          )}
        >
          {mutation.isError ? <ErrorAlert error={mutation.error} /> : null}
          <FormField label={t('fields.email')} error={fieldError(form.formState.errors.email)}>
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="email"
                autoFocus
                {...form.register('email')}
              />
            )}
          </FormField>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {t('forgot.submit')}
          </Button>
        </form>
      )}
      <BackToLogin />
    </AuthCard>
  );
}

export default ForgotPasswordPage;
