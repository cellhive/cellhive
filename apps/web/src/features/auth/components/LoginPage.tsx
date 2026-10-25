import { loginRequestSchema, type LoginRequest } from '@cellhive/contracts';
import { Alert, Button, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { submitWith, useFieldErrorText, zodResolver } from '../../../lib/forms/zod-form';
import { safeNextPath } from '../../../lib/navigation/safe-next';
import { meQuery, setupStatusQuery } from '../../../lib/session/session';
import { authApi } from '../api';
import { readLoginNotice } from '../forms';
import { ProviderButtons } from '../login/ProviderButtons';
import { loginErrorKey } from '../oidc-error/login-error';

import { AuthCard } from './AuthCard';

/**
 * `/login` (FRONTEND §2): OIDC provider buttons (T715) and email + password;
 * continues to `?next=` (internal only). `?error=<CODE>` of a failed OIDC
 * sign-in shows its translated message, never the raw value.
 */
export function LoginPage() {
  const { t } = useTranslation('auth');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const next = safeNextPath(searchParams.get('next'));
  const notice = readLoginNotice(location.state);
  const setup = useQuery(setupStatusQuery());
  const smtpEnabled = setup.data?.auth_config.smtp_enabled === true;
  // Responses are not parsed in production: a server before T707 has no `providers`.
  const providers = setup.data?.auth_config.providers ?? [];
  const ssoError = loginErrorKey(searchParams.get('error'));
  const fieldError = useFieldErrorText();
  const form = useForm<LoginRequest>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { email: notice?.email ?? '', password: '' },
  });
  const errors = form.formState.errors;
  const mutation = useMutation({
    mutationFn: authApi.login,
    meta: { ignoreUnauthenticated: true },
    onSuccess: async () => {
      // A new session: nothing cached for a previous user may leak into it.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'setup' });
      await queryClient.query(meQuery());
      void navigate(next ?? '/', { replace: true });
    },
  });

  return (
    <AuthCard title={t('login.title')} description={t('login.description')}>
      {notice === null ? null : (
        <Alert variant="success">{t(`login.notice.${notice.notice}`)}</Alert>
      )}
      {ssoError === null || !mutation.isIdle ? null : (
        <Alert variant="danger" data-testid="login-sso-error">
          {t(ssoError)}
        </Alert>
      )}
      <ProviderButtons providers={providers} next={next} />
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={submitWith(
          form.handleSubmit((values) => {
            mutation.mutate(values);
          }),
        )}
      >
        {mutation.isError ? (
          <ErrorAlert
            error={mutation.error}
            overrides={{ UNAUTHENTICATED: 'auth:login.invalidCredentials' }}
          />
        ) : null}
        <FormField label={t('fields.email')} error={fieldError(errors.email)}>
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="username"
              autoFocus={notice?.email === undefined}
              {...form.register('email')}
            />
          )}
        </FormField>
        <FormField label={t('fields.password')} error={fieldError(errors.password)}>
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="current-password"
              autoFocus={notice?.email !== undefined}
              {...form.register('password')}
            />
          )}
        </FormField>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : null}
          {t('login.submit')}
        </Button>
      </form>
      {smtpEnabled ? (
        <Link to="/forgot-password" className="text-accent underline-offset-4 hover:underline">
          {t('login.forgotPassword')}
        </Link>
      ) : (
        <p className="text-fg-muted">{t('login.forgotPasswordNoEmail')}</p>
      )}
    </AuthCard>
  );
}

export default LoginPage;
