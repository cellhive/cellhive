import {
  formCoverUrl,
  type FormSubmitRequest,
  type Id,
  type StoredFormSettings,
  type ViewDto,
} from '@cellhive/contracts';
import { Button, cn } from '@cellhive/ui';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Check, CircleDashed, Eye, Link2, PencilRuler, Send } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useParams, useSearchParams } from 'react-router';

import { linksApi } from '../../../lib/api/links';
import { attachmentsApi } from '../../../lib/attachments/api';
import { useFormatters } from '../../../lib/i18n/format';
import { canAddRecord, canEditView, canSaveViewConfig } from '../../../lib/permissions/access';
import { baseQuery, fieldsQuery, tablesQuery } from '../../../lib/query/queries';
import { useViewConfig, type ViewConfigState } from '../../../lib/views/use-view-config';
import { baseMembersQuery, formsApi, submissionStatusQuery } from '../api';
import { linkDetails } from '../model/link-details';
import { formSettingsOf, questionsOf } from '../model/questions';
import { FormRenderer } from '../renderer/FormRenderer';

import { FormBuilder } from './FormBuilder';
import { PrefillLinkDialog } from './PrefillLinkDialog';

import type { FormLinkSource, FormMember, FormUploadSource } from '../../../lib/forms/renderer';

/** `?form=` of the view URL: what an editor of the form sees. */
export const FORM_MODE_PARAM = 'form';
export const FORM_MODES = ['build', 'preview', 'fill'] as const;
export type FormMode = (typeof FORM_MODES)[number];

const MODE_ICONS = { build: PencilRuler, preview: Eye, fill: Send } as const;

export interface FormViewPageProps {
  /** The form view on screen (T310): its config holds the form. */
  readonly view: ViewDto;
}

function hasUserQuestion(
  form: StoredFormSettings,
  fields: readonly { id: string; type: string }[],
) {
  return form.fields.some(
    (item) => fields.find((field) => field.id === item.field)?.type === 'user',
  );
}

/**
 * A form view (`/b/:baseId/t/:tableId/v/:viewId`, SPEC §8, T315). Those who
 * may edit the view build the form (changes saved through the view config
 * state of T310: at once when allowed, else kept on this device with the
 * "Unsaved changes" bar), preview it, or fill it in; other members of the
 * base fill it in (`POST /views/:id/submit`). `?form=build|preview|fill`
 * picks the mode; `?prefill_<field_id>=…&hide_<field_id>=1` prefills.
 */
export function FormViewPage({ view }: FormViewPageProps) {
  const { t } = useTranslation('form');
  const { baseId = '', tableId = '' } = useParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const { data: fieldList } = useSuspenseQuery(fieldsQuery(tableId));
  const fields = fieldList.items;
  const canEdit = canEditView(base.access, tableId, view);
  const canSave = canSaveViewConfig(base.access, tableId, view);
  const state = useViewConfig(view, canSave);
  // Link questions name their table (T419).
  const tables = useQuery({ ...tablesQuery(baseId), enabled: canEdit });
  const tableNames = useMemo(
    () => new Map((tables.data?.items ?? []).map((table) => [table.id as string, table.name])),
    [tables.data],
  );
  const coverUrlOf = useCallback((id: string) => formCoverUrl(view.id, id), [view.id]);
  const format = useFormatters();
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const requested = params.get(FORM_MODE_PARAM);
  const mode: FormMode = !canEdit
    ? 'fill'
    : (FORM_MODES.find((item) => item === requested) ?? 'build');
  const setMode = (next: FormMode) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set(FORM_MODE_PARAM, next);
        return updated;
      },
      { replace: true },
    );
  };
  const [prefillOpen, setPrefillOpen] = useState(false);

  // What is being built (with unsaved changes) vs. what members fill in (saved).
  const edited = formSettingsOf(state.config.form);
  const saved = formSettingsOf(view.config.form);
  const needsMembers =
    mode !== 'build' && hasUserQuestion(mode === 'fill' ? saved : edited, fields);
  // Only people who can open the base (not every member of the organization, T320).
  const members = useQuery({ ...baseMembersQuery(baseId), enabled: needsMembers });
  const memberOptions = useMemo<FormMember[] | undefined>(
    () =>
      members.data?.items.map((member) => ({
        id: member.id,
        name: member.display_name,
        email: member.email,
      })),
    [members.data],
  );
  // A limit already reached shows at once, not after filling the form in (T320).
  const limited = mode === 'fill' && saved.require_login && saved.submission_limit !== 'none';
  const status = useQuery({ ...submissionStatusQuery(view.id), enabled: limited });
  const statusPending = limited && status.isPending;
  const reached =
    limited && status.data?.reached === true
      ? { nextAllowedAt: status.data.next_allowed_at }
      : null;

  const { change } = state;
  const onChange = useCallback(
    (form: StoredFormSettings) => {
      change({ form });
    },
    [change],
  );
  const submit = useCallback(
    (body: FormSubmitRequest) => formsApi.submit(view.id, body),
    [view.id],
  );
  // Link questions offer what the member's link picker offers (T402); files upload as in
  // the grid (T406), then the submission writes them (T410).
  // Records are told apart by the picker's display values (T421a), formatted
  // with the linked table's fields.
  const queryClient = useQueryClient();
  const links = useMemo<FormLinkSource>(
    () => ({
      search: async (fieldId, query, signal) => {
        const options = fields.find((field) => field.id === fieldId)?.options as
          { readonly link_table?: unknown } | undefined;
        const linkTable = typeof options?.link_table === 'string' ? options.link_table : null;
        const [page, linked] = await Promise.all([
          linksApi.candidates(
            fieldId,
            { search: query.search === '' ? null : query.search, offset: query.offset, limit: 20 },
            { signal },
          ),
          linkTable === null
            ? Promise.resolve(undefined)
            : queryClient
                .query({ ...fieldsQuery(linkTable), staleTime: 60_000 })
                .then((list) => list.items)
                .catch(() => undefined),
        ]);
        return {
          items: page.items.map((item) => ({
            id: item.id,
            title: item.title,
            details: linkDetails(item, page.fields, linked, locale),
          })),
          hasMore: page.has_more,
        };
      },
    }),
    [fields, locale, queryClient],
  );
  const uploads = useMemo<FormUploadSource>(
    () => ({
      start: (body, _token, signal) =>
        attachmentsApi.createUpload(
          { ...body, table_id: tableId as Id<'tbl'>, field_id: body.field_id as Id<'fld'> },
          signal,
        ),
      complete: (attachmentId, _token, signal) => attachmentsApi.complete(attachmentId, signal),
    }),
    [tableId],
  );

  let content: ReactNode;
  if (mode === 'build') {
    content = (
      <FormBuilder
        form={edited}
        fields={fields}
        onChange={onChange}
        // Covers are uploaded through the view: only by who may change it (T419).
        cover={{ viewId: view.id, canUpload: canSave }}
        tableNames={tableNames}
      />
    );
  } else if (mode === 'preview') {
    content = (
      <>
        <p role="note" className="mx-auto mt-4 w-full max-w-2xl px-4 text-fg-muted sm:px-0">
          {t('page.previewNote')}
        </p>
        <FormRenderer
          key="preview"
          form={edited}
          fields={fields}
          locale={locale}
          members={memberOptions}
          links={links}
          coverUrlOf={coverUrlOf}
        />
      </>
    );
  } else if (statusPending) {
    content = (
      <p role="status" className="mx-auto mt-8 w-full max-w-2xl px-4 text-fg-muted sm:px-0">
        {t('page.checkingLimit')}
      </p>
    );
  } else {
    content = (
      <FormRenderer
        // A saved change of the form (or of the prefill URL) starts the form over.
        key={`fill:${view.updated_at}:${search}:${reached === null ? 'open' : 'limit'}`}
        limitReached={reached}
        form={saved}
        fields={fields}
        locale={locale}
        search={search}
        submit={submit}
        members={memberOptions}
        links={links}
        uploads={uploads}
        coverUrlOf={coverUrlOf}
        blocked={canAddRecord(base.access, tableId) ? undefined : t('page.cannotSubmit')}
      />
    );
  }

  const prefillUrl = `${window.location.origin}/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(
    tableId,
  )}/v/${encodeURIComponent(view.id)}?${FORM_MODE_PARAM}=fill`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
          <div
            role="group"
            aria-label={t('page.modes')}
            className="flex rounded-md border border-line p-0.5"
          >
            {FORM_MODES.map((item) => {
              const Icon = MODE_ICONS[item];
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={mode === item}
                  className={cn(
                    'inline-flex h-control items-center gap-1.5 rounded-sm px-3 text-body',
                    mode === item
                      ? 'bg-accent-soft font-medium text-fg'
                      : 'text-fg-muted hover:bg-surface-sunken hover:text-fg',
                  )}
                  onClick={() => {
                    setMode(item);
                  }}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {t(`page.mode.${item}`)}
                </button>
              );
            })}
          </div>
          {mode === 'build' ? <SaveState state={state} /> : null}
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setPrefillOpen(true);
            }}
          >
            <Link2 aria-hidden="true" />
            {t('prefill.open')}
          </Button>
          <PrefillLinkDialog
            open={prefillOpen}
            onOpenChange={setPrefillOpen}
            questions={questionsOf(saved, fields)}
            url={prefillUrl}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">{content}</div>
    </div>
  );
}

/**
 * Whether the builder's changes are saved (T320): "Saving…" while a save is
 * on its way (or waiting for the pause), "Saved" once the view holds them,
 * "Not saved" when they are kept on this device only (no right, locked view).
 */
function SaveState({ state }: { state: ViewConfigState }) {
  const { t } = useTranslation('form');
  const [touched, setTouched] = useState(false);
  const changing = state.config.form !== state.saved.form;
  if (changing && !touched) setTouched(true);
  let kind: 'saving' | 'saved' | 'unsaved' | null;
  if (state.unsaved.includes('form')) kind = 'unsaved';
  else if (state.saving || changing) kind = 'saving';
  else kind = touched ? 'saved' : null;
  return (
    <p
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-label font-normal text-fg-muted"
      data-testid="form-save-state"
    >
      {kind === 'saving' ? <CircleDashed aria-hidden="true" className="size-3.5" /> : null}
      {kind === 'saved' ? <Check aria-hidden="true" className="size-3.5 text-success" /> : null}
      {kind === null ? null : t(`page.save.${kind}`)}
    </p>
  );
}

export default FormViewPage;
