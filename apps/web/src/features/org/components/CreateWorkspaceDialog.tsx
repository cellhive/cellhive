import {
  createWorkspaceRequestSchema,
  type CreateWorkspaceRequest,
  type MeOrganization,
} from '@cellhive/contracts';
import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
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
import { keys } from '../../../lib/query/keys';
import { orgApi } from '../api';
import { workspacePath } from '../hooks';

const FIELDS = ['name'] as const;

export interface CreateWorkspaceDialogProps {
  org: MeOrganization;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceDialog({ org, open, onOpenChange }: CreateWorkspaceDialogProps) {
  const { t } = useTranslation(['org', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fieldError = useFieldErrorText();
  const form = useForm<CreateWorkspaceRequest>({
    resolver: zodResolver(createWorkspaceRequestSchema),
    defaultValues: { name: '' },
  });
  const mutation = useMutation({
    mutationFn: (body: CreateWorkspaceRequest) => orgApi.createWorkspace(org.id, body),
    onSuccess: async (workspace) => {
      await queryClient.invalidateQueries({ queryKey: keys.workspaces(org.id) });
      queryClient.setQueryData(keys.workspace(workspace.id), workspace);
      close();
      void navigate(workspacePath(org, workspace));
    },
    onError: (error) => {
      applyServerErrors(error, FIELDS, form.setError);
    },
  });

  function close() {
    form.reset();
    mutation.reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t('org:createWorkspace.title')}
      description={t('org:createWorkspace.description', { org: org.name })}
      closeLabel={t('common:actions.close')}
    >
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
          label={t('org:createWorkspace.name')}
          error={fieldError(form.formState.errors.name)}
        >
          {(control) => <Input {...control} autoComplete="off" {...form.register('name')} />}
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {t('org:createWorkspace.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
