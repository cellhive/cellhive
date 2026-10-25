import {
  createBaseRequestSchema,
  type CreateBaseRequest,
  type WorkspaceDto,
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
import { basePath } from '../hooks';

export interface CreateBaseDialogProps {
  workspace: WorkspaceDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CreateBaseForm {
  name: string;
  description: string;
}

const FORM_FIELDS = ['name', 'description'] as const;

const formSchema = createBaseRequestSchema.pick({ name: true }).extend({
  description: createBaseRequestSchema.shape.description.unwrap().unwrap(),
});

export function CreateBaseDialog({ workspace, open, onOpenChange }: CreateBaseDialogProps) {
  const { t } = useTranslation(['org', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fieldError = useFieldErrorText();
  const form = useForm<CreateBaseForm>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', description: '' },
  });
  const mutation = useMutation({
    mutationFn: (values: CreateBaseForm) => {
      const description = values.description.trim();
      const body: CreateBaseRequest = {
        name: values.name,
        ...(description === '' ? {} : { description }),
      };
      return orgApi.createBase(workspace.id, body);
    },
    onSuccess: async (base) => {
      queryClient.setQueryData(keys.base(base.id), base);
      await queryClient.invalidateQueries({ queryKey: keys.bases(workspace.id) });
      close();
      void navigate(basePath(base));
    },
    onError: (error) => {
      applyServerErrors(error, FORM_FIELDS, form.setError);
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
      title={t('org:createBase.title')}
      description={t('org:createBase.description', { workspace: workspace.name })}
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
        {mutation.isError ? <ErrorAlert error={mutation.error} hidePaths={FORM_FIELDS} /> : null}
        <FormField label={t('org:createBase.name')} error={fieldError(form.formState.errors.name)}>
          {(control) => <Input {...control} autoComplete="off" {...form.register('name')} />}
        </FormField>
        <FormField
          label={t('org:createBase.descriptionLabel')}
          hint={t('org:createBase.descriptionHint')}
          error={fieldError(form.formState.errors.description)}
        >
          {(control) => <Input {...control} autoComplete="off" {...form.register('description')} />}
        </FormField>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            {t('org:createBase.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
