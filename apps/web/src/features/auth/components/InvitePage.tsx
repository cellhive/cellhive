import { PASSWORD_MIN_LENGTH, type InvitationPreview, type MeResponse } from '@cellhive/contracts';
import { Button, FormField, Input, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { browserTimeZone, useFormatters } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { meQuery, signOut } from '../../../lib/session/session';
import { authApi, invitationPreviewQuery } from '../api';
import { registerFormSchema, type LoginNotice, type RegisterForm } from '../forms';

import { AuthCard } from './AuthCard';

const REGISTER_FIELDS = ['display_name', 'password'] as const;

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function orgUrl(slug: string): string {
  return `/o/${encodeURIComponent(slug)}`;
}

/** Signed in as the invited user: one click joins the organization. */
function AcceptAsCurrentUser({ token }: { token: string }) {
  const { t } = useTranslation('auth');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () => authApi.acceptInvitation(token, {}),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: keys.me() });
      void navigate(orgUrl(result.organization.slug), { replace: true });
    },
  });
  return (
    <>
      {mutation.isError ? <ErrorAlert error={mutation.error} /> : null}
      <Button
        disabled={mutation.isPending}
        onClick={() => {
          mutation.mutate();
        }}
      >
        {mutation.isPending ? <Spinner /> : null}
        {t('invite.accept')}
      </Button>
    </>
  );
}

/** No account yet: create it with the invitation, then sign in. */
function RegisterAndAccept({ token, preview }: { token: string; preview: InvitationPreview }) {
  const { t, i18n } = useTranslation('auth');
  const navigate = useNavigate();
  const fieldError = useFieldErrorText();
  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { display_name: '', password: '', confirm_password: '' },
  });
  const errors = form.formState.errors;
  const mutation = useMutation({
    mutationFn: (values: RegisterForm) =>
      authApi.acceptInvitation(token, {
        display_name: values.display_name,
        password: values.password,
        locale: i18n.language,
        timezone: browserTimeZone(),
      }),
    meta: { ignoreUnauthenticated: true },
    onSuccess: (result) => {
      // Accepting does not sign in (SPEC §14.1A).
      const state: LoginNotice = { notice: 'invitationAccepted', email: preview.email };
      const next = encodeURIComponent(orgUrl(result.organization.slug));
      void navigate(`/login?next=${next}`, { replace: true, state });
    },
    onError: (error) => {
      applyServerErrors(error, REGISTER_FIELDS, form.setError);
    },
  });
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={submitWith(
        form.handleSubmit((values) => {
          mutation.mutate(values);
        }),
      )}
    >
      {mutation.isError ? <ErrorAlert error={mutation.error} hidePaths={REGISTER_FIELDS} /> : null}
      <FormField label={t('fields.email')}>
        {(control) => (
          <Input {...control} type="email" value={preview.email} readOnly autoComplete="username" />
        )}
      </FormField>
      <FormField label={t('fields.displayName')} error={fieldError(errors.display_name)}>
        {(control) => (
          <Input {...control} autoComplete="name" autoFocus {...form.register('display_name')} />
        )}
      </FormField>
      <FormField
        label={t('fields.password')}
        hint={t('fields.passwordHint', { min: PASSWORD_MIN_LENGTH })}
        error={fieldError(errors.password)}
      >
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="new-password"
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
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? <Spinner /> : null}
        {t('invite.createAccount')}
      </Button>
    </form>
  );
}

function InviteActions({
  token,
  preview,
  me,
}: {
  token: string;
  preview: InvitationPreview;
  me: MeResponse | null;
}) {
  const { t } = useTranslation('auth');
  if (me !== null && sameEmail(me.user.email, preview.email)) {
    return <AcceptAsCurrentUser token={token} />;
  }
  if (me !== null) {
    return (
      <>
        <p className="text-fg-muted">
          {t('invite.wrongAccount', { current: me.user.email, invited: preview.email })}
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            void signOut(`/invite/${encodeURIComponent(token)}`);
          }}
        >
          {t('invite.signOut')}
        </Button>
      </>
    );
  }
  if (preview.account_exists) {
    return (
      <Button asChild>
        <Link to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
          {t('invite.signInToAccept', { email: preview.email })}
        </Link>
      </Button>
    );
  }
  return <RegisterAndAccept token={token} preview={preview} />;
}

/** `/invite/:token`: what the invitation is for, then sign in or register and accept. */
export function InvitePage() {
  const { t } = useTranslation('auth');
  const { token = '' } = useParams();
  const format = useFormatters();
  const preview = useQuery(invitationPreviewQuery(token));
  const me = useQuery(meQuery());

  if (preview.isPending || me.isPending) {
    return <Skeleton className="h-48" />;
  }
  if (preview.isError) {
    if (isApiError(preview.error) && preview.error.code === 'INVITATION_INVALID') {
      return (
        <AuthCard title={t('invite.invalidTitle')} description={t('invite.invalidDescription')}>
          <Link to="/login" className="text-accent underline-offset-4 hover:underline">
            {t('backToLogin')}
          </Link>
        </AuthCard>
      );
    }
    return (
      <AuthCard title={t('invite.title')}>
        <ErrorAlert error={preview.error} />
      </AuthCard>
    );
  }
  const invitation = preview.data;
  return (
    <AuthCard
      title={t('invite.title')}
      description={t('invite.description', {
        org: invitation.organization.name,
        role: t(`invite.roles.${invitation.role}`),
      })}
    >
      <p className="text-label font-normal text-fg-muted">
        {t('invite.forEmail', { email: invitation.email })}
        {' · '}
        {t('invite.expires', { date: format.dateTime(invitation.expires_at) })}
      </p>
      <InviteActions token={token} preview={invitation} me={me.data ?? null} />
    </AuthCard>
  );
}

export default InvitePage;
