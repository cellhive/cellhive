import { Button, cn, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { useDocumentTitle } from '../../../lib/a11y/use-document-title';
import { baseAdminApi } from '../../../lib/api/base-admin';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { keys } from '../../../lib/query/keys';
import { baseQuery } from '../../../lib/query/queries';
import { meQuery } from '../../../lib/session/session';
import { showErrorToast, showToast } from '../../../lib/toast/toast';

import type { BaseDetail } from '@cellhive/contracts';

/** The limits of `updateBaseRequestSchema` (CONTRACTS §5A). */
const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;

const TEXTAREA_CLASSES =
  'min-h-20 w-full rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg max-lg:text-[16px] ' +
  'placeholder:text-fg-subtle aria-invalid:border-danger';

const SECTION_CLASSES = 'flex flex-col gap-4 rounded-lg border border-line bg-surface p-5';

function basePath(baseId: string): string {
  return `/b/${encodeURIComponent(baseId)}`;
}

/**
 * `/b/:baseId/settings` (FRONTEND §17), base admins (route guard): the
 * base's own settings — name and description (`PATCH /bases/:id`), its ID
 * for the API, and "Delete base" for those the API lets delete it (owner,
 * organization owner/admin; a workspace admin gets `403` explained). The
 * other pages are in the settings nav, not repeated here.
 */
export function BaseSettingsGeneralPage() {
  const { t } = useTranslation('baseSettings');
  const { baseId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  useDocumentTitle(`${t('general.title')} · ${base.name}`);
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <PageHeading
        back={{ to: basePath(base.id), label: t('page.back', { name: base.name }) }}
        icon={Settings}
        title={t('general.title')}
      />
      <div
        className={cn('flex max-w-3xl flex-col gap-6 py-6', PAGE_GUTTER)}
        data-testid="base-settings-general"
      >
        {/* Saved values remount the form, so it starts clean from them. */}
        <BaseInfoForm key={`${base.name}\u0000${base.description ?? ''}`} base={base} />
        <BaseFacts base={base} />
        <DeleteBaseSection base={base} />
      </div>
    </div>
  );
}

function BaseInfoForm({ base }: { readonly base: BaseDetail }) {
  const { t } = useTranslation('baseSettings');
  const queryClient = useQueryClient();
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description ?? '');
  const nextDescription = description.trim() === '' ? null : description;
  const changes = {
    ...(name.trim() === base.name ? {} : { name: name.trim() }),
    ...(nextDescription === base.description ? {} : { description: nextDescription }),
  };
  const save = useMutation({
    mutationFn: () => baseAdminApi.update(base.id, changes),
    onSuccess: async (updated) => {
      queryClient.setQueryData(keys.base(base.id), updated);
      // The workspace tree of the sidebar lists the base by name.
      await queryClient.invalidateQueries({ queryKey: keys.bases(base.workspace_id) });
      showToast({ variant: 'success', message: t('general.info.saved') });
    },
  });
  const unchanged = Object.keys(changes).length === 0;
  return (
    <section aria-labelledby="base-info-heading" className={SECTION_CLASSES}>
      <h2 id="base-info-heading" className="text-heading">
        {t('general.info.title')}
      </h2>
      <form
        className="flex flex-col gap-4"
        data-testid="base-info-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!unchanged && name.trim() !== '') save.mutate();
        }}
      >
        <FormField label={t('general.info.name')}>
          {(control) => (
            <Input
              {...control}
              maxLength={NAME_MAX}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField label={t('general.info.description')} hint={t('general.info.descriptionHint')}>
          {(control) => (
            <textarea
              {...control}
              rows={3}
              maxLength={DESCRIPTION_MAX}
              className={TEXTAREA_CLASSES}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          )}
        </FormField>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={unchanged || name.trim() === '' || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            {t('general.info.save')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function BaseFacts({ base }: { readonly base: BaseDetail }) {
  const { t } = useTranslation('baseSettings');
  const format = useFormatters();
  return (
    <section aria-labelledby="base-facts-heading" className={SECTION_CLASSES}>
      <h2 id="base-facts-heading" className="text-heading">
        {t('general.facts.title')}
      </h2>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
        <dt className="text-fg-muted">{t('general.facts.id')}</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-label font-normal break-all">
            {base.id}
          </code>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              // The Clipboard API exists only in secure contexts (HTTPS or localhost).
              if (!('clipboard' in navigator)) return;
              navigator.clipboard.writeText(base.id).then(
                () => {
                  showToast({ variant: 'success', message: t('general.facts.copied') });
                },
                () => undefined,
              );
            }}
          >
            {t('general.facts.copy')}
          </Button>
        </dd>
        <dt className="text-fg-muted">{t('general.facts.created')}</dt>
        <dd>{format.dateTime(base.created_at)}</dd>
      </dl>
    </section>
  );
}

function DeleteBaseSection({ base }: { readonly base: BaseDetail }) {
  const { t } = useTranslation('baseSettings');
  const me = useQuery(meQuery());
  const [open, setOpen] = useState(false);
  const org = me.data?.orgs.find((item) => item.id === base.organization_id);
  // Workspace admins may delete too, but the base does not say who they are: the API decides.
  const allowed =
    me.data !== undefined &&
    me.data !== null &&
    (base.owner_id === me.data.user.id || org?.role === 'owner' || org?.role === 'admin');
  if (!allowed || org === undefined) return null;
  return (
    <section
      aria-labelledby="base-delete-heading"
      className={cn(SECTION_CLASSES, 'border-danger/40 sm:flex-row sm:items-center')}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="base-delete-heading" className="text-heading text-danger">
          {t('general.delete.title')}
        </h2>
        <p className="text-fg-muted">{t('general.delete.description', { name: base.name })}</p>
      </div>
      <Button
        variant="danger"
        className="shrink-0 self-start sm:self-center"
        data-testid="delete-base-open"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('general.delete.open')}
      </Button>
      {open ? (
        <DeleteBaseDialog
          base={base}
          orgSlug={org.slug}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

function DeleteBaseDialog({
  base,
  orgSlug,
  onClose,
}: {
  readonly base: BaseDetail;
  readonly orgSlug: string;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(['baseSettings', 'common']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState('');
  const refreshTree = () =>
    queryClient.invalidateQueries({ queryKey: keys.bases(base.workspace_id) });

  const restore = async () => {
    try {
      await baseAdminApi.restore(base.id);
      await refreshTree();
      await navigate(basePath(base.id));
      showToast({
        variant: 'success',
        message: t('baseSettings:general.delete.restored', { name: base.name }),
      });
    } catch (error) {
      showErrorToast(error);
    }
  };

  const remove = useMutation({
    mutationFn: () => baseAdminApi.remove(base.id),
    onSuccess: async () => {
      await navigate(`/o/${encodeURIComponent(orgSlug)}`, { replace: true });
      queryClient.removeQueries({ queryKey: keys.base(base.id) });
      await refreshTree();
      showToast({
        variant: 'success',
        message: t('baseSettings:general.delete.deleted', { name: base.name }),
        actions: [
          {
            label: t('baseSettings:general.delete.undo'),
            primary: true,
            onClick: () => {
              void restore();
            },
          },
        ],
      });
    },
  });
  const confirmed = typed.trim() === base.name;
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(next) => {
        if (!next && !remove.isPending) onClose();
      }}
      title={t('baseSettings:general.delete.confirmTitle', { name: base.name })}
      description={t('baseSettings:general.delete.description', { name: base.name })}
      closeLabel={t('common:actions.close')}
      className="max-w-md"
    >
      <form
        className="flex flex-col gap-4"
        data-testid="delete-base-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed) remove.mutate();
        }}
      >
        <FormField label={t('baseSettings:general.delete.confirmLabel', { name: base.name })}>
          {(control) => (
            <Input
              {...control}
              autoFocus
              autoComplete="off"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          )}
        </FormField>
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={remove.isPending} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={!confirmed || remove.isPending}
            data-testid="delete-base-confirm"
          >
            {remove.isPending ? <Spinner /> : null}
            {t('baseSettings:general.delete.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default BaseSettingsGeneralPage;
