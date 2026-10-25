import { PASSWORD_MIN_LENGTH, type SetupStatus } from '@cellhive/contracts';
import { Button, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import {
  applyServerErrors,
  submitWith,
  useFieldErrorText,
  zodResolver,
} from '../../../lib/forms/zod-form';
import { browserTimeZone } from '../../../lib/i18n/format';
import { keys } from '../../../lib/query/keys';
import { authApi } from '../api';
import { setupFormSchema, type LoginNotice, type SetupForm } from '../forms';

import { AuthCard } from './AuthCard';

const FIELDS = ['email', 'password', 'display_name', 'org_name'] as const;

/** `/setup`: first administrator and organization (SPEC §14.1A). */
export function SetupPage() {
  const { t, i18n } = useTranslation('auth');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fieldError = useFieldErrorText();
  const form = useForm<SetupForm>({
    resolver: zodResolver(setupFormSchema),
    defaultValues: {
      email: '',
      display_name: '',
      org_name: '',
      password: '',
      confirm_password: '',
    },
  });
  const errors = form.formState.errors;
  const mutation = useMutation({
    mutationFn: (values: SetupForm) =>
      authApi.setup({
        email: values.email,
        password: values.password,
        display_name: values.display_name,
        org_name: values.org_name,
        // Defaults of the new organization: the language and zone of this browser.
        locale: i18n.language,
        timezone: browserTimeZone(),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<SetupStatus>(keys.setupStatus(), (status) =>
        status === undefined ? status : { ...status, setup_required: false },
      );
      const state: LoginNotice = { notice: 'setupComplete', email: result.user.email };
      void navigate('/login', { replace: true, state });
    },
    onError: (error) => {
      applyServerErrors(error, FIELDS, form.setError);
    },
  });

  return (
    <AuthCard title={t('setup.title')} description={t('setup.description')}>
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
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-heading">{t('setup.adminSection')}</legend>
          <FormField label={t('fields.displayName')} error={fieldError(errors.display_name)}>
            {(control) => (
              <Input {...control} autoComplete="name" {...form.register('display_name')} />
            )}
          </FormField>
          <FormField label={t('fields.email')} error={fieldError(errors.email)}>
            {(control) => (
              <Input {...control} type="email" autoComplete="email" {...form.register('email')} />
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
          <FormField
            label={t('fields.confirmPassword')}
            error={fieldError(errors.confirm_password)}
          >
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="new-password"
                {...form.register('confirm_password')}
              />
            )}
          </FormField>
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-heading">{t('setup.orgSection')}</legend>
          <FormField
            label={t('fields.orgName')}
            hint={t('setup.orgHint')}
            error={fieldError(errors.org_name)}
          >
            {(control) => (
              <Input {...control} autoComplete="organization" {...form.register('org_name')} />
            )}
          </FormField>
        </fieldset>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner /> : null}
          {t('setup.submit')}
        </Button>
      </form>
    </AuthCard>
  );
}

export default SetupPage;
