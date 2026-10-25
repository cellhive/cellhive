import { createRoleRequestSchema } from '@cellhive/contracts';
import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../../lib/errors/translate';
import { issueToDetail } from '../../../../lib/forms/zod-form';

const nameSchema = createRoleRequestSchema.shape.name;
const NAME_PATHS = ['name'] as const;

export interface RoleNameDialogProps {
  readonly mode: 'create' | 'rename';
  /** The current name (rename). */
  readonly initialName?: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
  /** Clears the mutation's error when the name is edited. */
  readonly onEdit: () => void;
}

/**
 * Name of a new role, or the new name of a custom one (CONTRACTS §14: 1–100
 * characters, unique in the base ignoring case). A taken name
 * (`409 NAME_CONFLICT`) is shown under the input; other errors by `code`.
 */
export function RoleNameDialog({
  mode,
  initialName = '',
  pending,
  error,
  onSubmit,
  onClose,
  onEdit,
}: RoleNameDialogProps) {
  const { t, i18n } = useTranslation(['baseSettings', 'errors']);
  const [name, setName] = useState(initialName);
  const [issue, setIssue] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The old name starts selected: typing replaces it.
    input.current?.select();
  }, []);
  const conflict =
    isApiError(error) && error.code === 'NAME_CONFLICT'
      ? t('baseSettings:roles.nameTaken')
      : undefined;

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = nameSchema.safeParse(name, { reportInput: true });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      setIssue(first === undefined ? undefined : translateDetail(i18n, issueToDetail(first)));
      return;
    }
    if (mode === 'rename' && parsed.data === initialName) {
      onClose();
      return;
    }
    onSubmit(parsed.data);
  };

  return (
    <Dialog
      open
      layout="sheet"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(
        mode === 'create' ? 'baseSettings:roles.create.title' : 'baseSettings:roles.rename.title',
      )}
      description={mode === 'create' ? t('baseSettings:roles.create.description') : undefined}
      closeLabel={t('baseSettings:page.close')}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        data-testid={`role-${mode}-form`}
        onSubmit={submit}
      >
        <FormField label={t('baseSettings:roles.name')} error={issue ?? conflict}>
          {(control) => (
            <Input
              {...control}
              ref={input}
              autoComplete="off"
              maxLength={100}
              value={name}
              data-testid="role-name-input"
              onChange={(event) => {
                setName(event.target.value);
                setIssue(undefined);
                onEdit();
              }}
            />
          )}
        </FormField>
        {error !== null && error !== undefined && conflict === undefined ? (
          <ErrorAlert error={error} hidePaths={NAME_PATHS} />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('baseSettings:page.cancel')}
          </Button>
          <Button type="submit" disabled={pending} data-testid={`role-${mode}-submit`}>
            {pending ? <Spinner /> : null}
            {t(
              mode === 'create'
                ? 'baseSettings:roles.create.submit'
                : 'baseSettings:roles.rename.submit',
            )}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
