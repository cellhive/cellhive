import { isDateOnlyFormat } from '@cellhive/field-types';
import { Alert, Button, Checkbox, cn, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { Suspense, useMemo, useState, type SyntheticEvent, ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../lib/api';
import { isApiError } from '../../../lib/api/client';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { canManageSchema, canPickLinks } from '../../../lib/permissions/access';
import { keys } from '../../../lib/query/keys';
import { baseQuery, fieldsQuery, orgQuery, tablesQuery } from '../../../lib/query/queries';
import { trackJob } from '../../../lib/realtime/jobs';
import { isFieldConverting } from '../../../lib/schema/conversion';
import { meQuery } from '../../../lib/session/session';
import { showToast } from '../../../lib/toast/toast';
import { AutomationCard } from '../button/AutomationCard';
import { ButtonOptionsForm } from '../button/ButtonOptionsForm';
import { ComputedConversionDialog } from '../convert/ComputedConversionDialog';
import { ConversionPane, type ConsentState, type PaneMode } from '../convert/ConversionPane';
import { ConversionSettingsForm } from '../convert/ConversionSettingsForm';
import { DisableTwoWayDialog } from '../convert/DisableTwoWayDialog';
import {
  computedConversionRequest,
  conversionRequestOf,
  EMPTY_SETTINGS,
  isComputedType,
  isRefused,
  linkChangeOf,
  requiredConsents,
  settingsKindOf,
  sourceTypeOf,
  styleCheckOf,
  type ConversionSettingsDraft,
} from '../convert/model';
import { TypePicker } from '../convert/TypePicker';
import { useConversionPreview } from '../convert/use-conversion-preview';
import {
  onlyReminderErrors,
  REMINDER_PATH,
  serverReminderIssues,
} from '../datetime/reminder/draft';
import { ReminderSection } from '../datetime/reminder/ReminderSection';
import {
  buttonLabelOf,
  CREATABLE_TYPES,
  createBody,
  deletedOptions,
  draftOf,
  needsConversion,
  REQUIRABLE_TYPES,
  UNIQUE_TYPES,
  updateBody,
  validateDraft,
  type DraftIssue,
  type FieldDraft,
} from '../draft';
import { useConvertField, useCreateField, useUpdateField } from '../mutations';

import { FieldPreview } from './FieldPreview';
import { AttachmentOptionsForm } from './options/AttachmentOptionsForm';
import { AutoNumberRulesBuilder } from './options/AutoNumberRulesBuilder';
import { DatetimeOptionsForm, SystemTimeOptionsForm } from './options/DatetimeOptionsForm';
import { LinkOptionsForm } from './options/LinkOptionsForm';
import { NumberOptionsForm } from './options/NumberOptionsForm';
import { SelectOptionsEditor } from './options/SelectOptionsEditor';
import { TextOptionsForm } from './options/TextOptionsForm';
import { UserOptionsForm } from './options/UserOptionsForm';
import { issueAt, useIssueText } from './shared';

import type { RecordFilterEditorProps } from '../../../lib/schema/field-tools';
import type {
  FormulaDraft,
  FormulaFieldComponent,
  FormulaSaveOutcome,
} from '../../../lib/schema/formula-tools';
import type { LookupFieldEditor } from '../../../lib/schema/lookup-tools';
import type { FieldDto, TableDto, UpdateFieldRequest } from '@cellhive/contracts';

export interface FieldDialogProps {
  readonly tableId: string;
  /** The field to edit; absent: a new field. */
  readonly field?: FieldDto | undefined;
  /** New field: its place in the field order (absent → last). */
  readonly index?: number | undefined;
  /** Live fields of the table (a new one at `index >= count` stays last). */
  readonly fieldCount: number;
  readonly onClose: () => void;
  /** `422 FIELD_LIMIT_EXCEEDED`: the caller explains the limit (FRONTEND §4.3). */
  readonly onLimitExceeded: (limit: number | undefined) => void;
  /** Conditions of a link field (T413, the view filter builder given by the route). */
  readonly RecordFilterEditor?: ComponentType<RecordFilterEditorProps> | undefined;
  /** Formula fields (T466, `features/formula` given by the route); absent: not offered. */
  readonly Formula?: FormulaFieldComponent | undefined;
  /** Configuration of lookup fields (T467, `features/lookup` given by the route). */
  readonly LookupEditor?: LookupFieldEditor | undefined;
}

/** `errors[].params.limit` of a `FIELD_LIMIT_EXCEEDED` problem. */
export function fieldLimitOf(error: unknown): number | undefined {
  if (!isApiError(error)) return undefined;
  for (const item of error.errors) {
    const limit = item.params?.['limit'];
    if (typeof limit === 'number') return limit;
  }
  return undefined;
}

/** Server details that belong next to the name input. */
function serverNameIssue(error: unknown): DraftIssue | undefined {
  if (!isApiError(error)) return undefined;
  if (error.code === 'NAME_CONFLICT') return { path: 'name', detail: { code: 'NAME_CONFLICT' } };
  if (error.code !== 'VALIDATION_FAILED') return undefined;
  const item = error.errors.find((detail) => detail.path === 'name');
  if (item === undefined) return undefined;
  return {
    path: 'name',
    detail:
      item.params === undefined ? { code: item.code } : { code: item.code, params: item.params },
  };
}

const TEXTAREA_CLASSES =
  'min-h-16 w-full rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg ' +
  'placeholder:text-fg-subtle aria-invalid:border-danger';

const NO_CONSENTS: ConsentState = { confirm: false, acceptDataLoss: false };

/**
 * Currency of the organization owning the table (its default, SPEC §20):
 * a new currency field starts with it (S2 QA: VND for a Vietnamese
 * organization, whatever the user's language). `undefined` while loading.
 */
function useOrgCurrency(tableId: string): string | undefined {
  const { orgId } = useBaseOf(tableId);
  const org = useQuery({ ...orgQuery(orgId ?? ''), enabled: orgId !== undefined });
  return org.data?.settings.currency;
}

/** The base of the table (from the cache of the grid's route) and its organization. */
function useBaseOf(tableId: string) {
  const queryClient = useQueryClient();
  const baseId = queryClient.getQueryData<TableDto>(keys.tableMeta(tableId))?.base_id;
  const base = useQuery({ ...baseQuery(baseId ?? ''), enabled: baseId !== undefined });
  return { baseId, base: base.data, orgId: base.data?.organization_id };
}

/** Tables of the base (T413: a link field may link to the tables the user reads). */
function useBaseTables(tableId: string) {
  const { baseId, base } = useBaseOf(tableId);
  const tables = useQuery({ ...tablesQuery(baseId ?? ''), enabled: baseId !== undefined });
  const all = tables.data?.items;
  const linkable = useMemo(
    () => (all ?? []).filter((table) => canPickLinks(base?.access, table.id)),
    [all, base?.access],
  );
  return { all: all ?? [], linkable };
}

/** The pane's mode for a conversion or a style check. */
function paneModeOf(field: FieldDto | undefined, draft: FieldDraft, style: boolean): PaneMode {
  if (style) return 'style';
  if (field?.type === 'link') {
    return linkChangeOf(field, draft) === 'to_single' ? 'to_single' : 'to_two_way';
  }
  return 'type';
}

/** Whether a server error names the reverse field of a two-way link (T415). */
function reverseNameIssue(error: unknown): DraftIssue | undefined {
  if (!isApiError(error)) return undefined;
  if (error.code === 'NAME_CONFLICT') {
    return { path: 'options.bidirectional_link_field_name', detail: { code: 'NAME_CONFLICT' } };
  }
  const item = error.errors.find((detail) => detail.path.endsWith('bidirectional_link_field_name'));
  return item === undefined
    ? undefined
    : { path: 'options.bidirectional_link_field_name', detail: { code: item.code } };
}

/**
 * Create or edit a field (T207, board "Đổi kiểu field"): name, type,
 * options of the type, required / unique, description, and a live
 * preview. On a saved field (T414, T415) a new type, several values → one,
 * or one-way ↔ two-way link is a conversion: the dialog widens with the
 * server's preview (counts, samples, dependents) and the boxes to tick,
 * and `PUT /fields/:id` starts the background job. Validated with the
 * `contracts` and `field-types` schemas before sending; server errors are
 * placed: `NAME_CONFLICT` on the name, `SCHEMA_LOCKED` as a banner with
 * retry, `FIELD_LIMIT_EXCEEDED` handed to the caller.
 */
export function FieldDialog({
  tableId,
  field,
  index,
  fieldCount,
  onClose,
  onLimitExceeded,
  RecordFilterEditor,
  Formula,
  LookupEditor,
}: FieldDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const issueText = useIssueText();
  const format = useFormatters();
  const me = useQuery(meQuery());
  const currency = useOrgCurrency(tableId);
  const { baseId, base, orgId } = useBaseOf(tableId);
  const tables = useBaseTables(tableId);
  const [draft, setDraft] = useState<FieldDraft>(() => draftOf(field));
  const [settings, setSettings] = useState<ConversionSettingsDraft>(EMPTY_SETTINGS);
  const [consents, setConsents] = useState<ConsentState>(NO_CONSENTS);
  /** (T469) Options of a lookup this field is being converted to, waiting for confirmation. */
  const [lookupConversion, setLookupConversion] = useState<Readonly<
    Record<string, unknown>
  > | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const create = useCreateField(tableId);
  const update = useUpdateField(tableId);
  const convert = useConvertField(tableId);
  const queryClient = useQueryClient();
  const editing = field !== undefined;
  const converting = field !== undefined && isFieldConverting(field);

  const convertRequest = useMemo(
    () => (field === undefined ? null : conversionRequestOf(field, draft, settings)),
    [field, draft, settings],
  );
  const styleCheck = useMemo(
    () => (field === undefined || convertRequest !== null ? null : styleCheckOf(field, draft)),
    [field, draft, convertRequest],
  );
  const previewBody = convertRequest ?? styleCheck;
  const previewState = useConversionPreview(field?.id ?? '', converting ? null : previewBody);
  const preview = previewState.preview;
  const required = preview === undefined ? null : requiredConsents(preview);
  // A new answer (other counts) asks again: a box ticked for other numbers does not carry over.
  const previewKey =
    preview === undefined
      ? ''
      : `${preview.kind}:${String(preview.affected)}:${String(preview.lost)}:${String(preview.truncated)}`;
  const [consentKey, setConsentKey] = useState(previewKey);
  if (consentKey !== previewKey) {
    setConsentKey(previewKey);
    setConsents(NO_CONSENTS);
  }

  const linkChange = field === undefined ? null : linkChangeOf(field, draft);
  const linkedTableId = draft.type === 'link' ? draft.link.linkTable : '';
  const linkedTable = tables.all.find((table) => table.id === linkedTableId);
  const thisTable = tables.all.find((table) => table.id === tableId);
  const linkedFields = useQuery({
    ...fieldsQuery(linkedTableId),
    enabled: field?.type === 'link' && draft.link.symmetricFieldId != null && linkedTableId !== '',
  });
  const partnerName = linkedFields.data?.items.find(
    (item) => item.id === draft.link.symmetricFieldId,
  )?.name;

  const mutation = field === undefined ? create : convertRequest !== null ? convert : update;
  const { issues, config } = useMemo(() => validateDraft(draft), [draft]);
  const shownIssues = submitted ? issues : [];
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  const now = useMemo(() => new Date(), []);

  const error = mutation.error;
  const descriptionIssue = issueAt(shownIssues, 'description');
  const reverseIssue = linkChange === 'to_two_way' ? reverseNameIssue(convert.error) : undefined;
  const nameIssue =
    issueAt(shownIssues, 'name') ??
    (reverseIssue === undefined ? serverNameIssue(error) : undefined);
  const locked = isApiError(error) && error.code === 'SCHEMA_LOCKED';
  // (T554) `422` details of the reminder are shown at their controls, not in a banner.
  const reminderOnly = onlyReminderErrors(error);
  const otherError =
    error !== null &&
    nameIssue === undefined &&
    reverseIssue === undefined &&
    !locked &&
    !reminderOnly
      ? error
      : null;
  const reminderIssues = [
    ...shownIssues.filter(
      (issue) => issue.path === REMINDER_PATH || issue.path.startsWith(`${REMINDER_PATH}.`),
    ),
    ...serverReminderIssues(error),
  ];
  const optionIssues = reverseIssue === undefined ? shownIssues : [...shownIssues, reverseIssue];

  const change = (next: Partial<FieldDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    if (error !== null) mutation.reset();
  };

  // Two-way needs schema rights on both tables (ADR-28 §1, CONTRACTS §4.4).
  const twoWayLocked =
    linkedTableId === '' || base === undefined
      ? undefined
      : !canManageSchema(base.access, linkedTableId) || !canManageSchema(base.access, tableId)
        ? t('field:link.twoWayNoRights', { table: linkedTable?.name ?? '' })
        : undefined;

  const consentsGiven =
    required === null ||
    ((!required.confirm || consents.confirm) &&
      (!required.acceptDataLoss || consents.acceptDataLoss));
  const conversionReady =
    convertRequest === null ||
    (preview !== undefined && !previewState.stale && !isRefused(preview) && consentsGiven);
  // The legacy lock (multiple → single) for fields whose change cannot be previewed.
  const blocked =
    field !== undefined &&
    needsConversion(field, draft) &&
    convertRequest === null &&
    // (T469) To a formula: waiting for its expression, not refused.
    !isComputedType(draft.type);

  const startConversion = (renamed: UpdateFieldRequest | null) => {
    if (field === undefined || convertRequest === null || required === null) return;
    const run = () => {
      convert.mutate(
        {
          fieldId: field.id,
          body: {
            ...convertRequest,
            ...(required.confirm ? { confirm: true } : {}),
            ...(required.acceptDataLoss ? { accept_data_loss: true } : {}),
          },
          linkedTableId: field.type === 'link' ? linkedTableId : undefined,
        },
        {
          onSuccess: (result) => {
            if (result.job_id === null) {
              showToast({ variant: 'success', message: t('field:convert.applied') });
            }
            onClose();
          },
          onError: (failure) => {
            if (!isApiError(failure)) return;
            if (failure.code === 'FIELD_LIMIT_EXCEEDED') onLimitExceeded(fieldLimitOf(failure));
            if (failure.code === 'CONVERSION_REQUIRES_CONFIRM') {
              setConsents(NO_CONSENTS);
              previewState.retry();
            }
          },
        },
      );
    };
    if (renamed === null) {
      run();
      return;
    }
    // Name and description first: the field is locked while it converts.
    update.mutate({ fieldId: field.id, body: renamed }, { onSuccess: run });
  };

  /** A new or changed formula: its values are computed in the background (T456). */
  const announceBackfill = (saved: FieldDto) => {
    if (saved.type === 'formula' && saved.compute_state === 'backfilling') {
      showToast({ variant: 'info', message: t('field:formula.backfilling', { name: saved.name }) });
    }
  };

  const save = () => {
    setSubmitted(true);
    if (issues.length > 0 || blocked || converting) return;
    if (field === undefined) {
      create.mutate(
        { body: createBody(draft), index, count: fieldCount },
        {
          onSuccess: (created) => {
            announceBackfill(created);
            onClose();
          },
          onError: (failure) => {
            if (isApiError(failure) && failure.code === 'FIELD_LIMIT_EXCEEDED') {
              onLimitExceeded(fieldLimitOf(failure));
            }
          },
        },
      );
      return;
    }
    if (convertRequest !== null) {
      if (!conversionReady) return;
      const renamed: Record<string, unknown> = {};
      if (draft.name.trim() !== field.name) renamed['name'] = draft.name.trim();
      const description = draft.description.trim();
      if (description !== (field.description ?? '')) {
        renamed['description'] = description === '' ? null : description;
      }
      startConversion(Object.keys(renamed).length === 0 ? null : renamed);
      return;
    }
    const body = updateBody(field, draft);
    if (body === null) {
      onClose();
      return;
    }
    const removed = deletedOptions(draft).length;
    update.mutate(
      { fieldId: field.id, body },
      {
        onSuccess: (updated) => {
          announceBackfill(updated);
          if (updated.job_id !== null) {
            // Progress from `job.progress` (T204), `GET /jobs/:id` as a fallback.
            trackJob(updated.job_id, {
              messages: {
                running: t('field:select.removing', { count: removed }),
                succeeded: t('field:select.removed', { count: removed }),
                failed: t('field:select.removeFailed'),
              },
              onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: keys.table(tableId) });
              },
            });
          } else if (removed > 0) {
            showToast({ variant: 'info', message: t('field:select.removing', { count: removed }) });
          }
          onClose();
        },
      },
    );
  };

  /**
   * (T466) "Confirm" of the formula editor: the field is saved with that
   * formula. A formula error (`422 FORMULA_*`, with positions) is shown by
   * the editor; anything else (the name…) by this form.
   */
  const saveFormula = async (formula: FormulaDraft): Promise<FormulaSaveOutcome> => {
    const next: FieldDraft = { ...draft, formula };
    setDraft(next);
    if (error !== null) mutation.reset();
    setSubmitted(true);
    if (validateDraft(next).issues.length > 0 || converting) {
      return { ok: false, formError: true, error: null };
    }
    if (field !== undefined && field.type !== 'formula') {
      // (T469) A conversion to a formula: "Confirm" checks the formula (the same checks as
      // `PUT`) and keeps it; the dialog then previews the conversion and asks to confirm it.
      const request = conversionRequestOf(field, next, settings);
      if (request === null) return { ok: false, formError: true, error: null };
      try {
        await api.fields.convertPreview(field.id, request);
        return { ok: true };
      } catch (failure) {
        const inFormula = isApiError(failure) && failure.code.startsWith('FORMULA_');
        return { ok: false, formError: !inFormula, error: failure };
      }
    }
    return new Promise((resolve) => {
      const failed = (failure: unknown) => {
        const inFormula = isApiError(failure) && failure.code.startsWith('FORMULA_');
        if (isApiError(failure) && failure.code === 'FIELD_LIMIT_EXCEEDED') {
          onLimitExceeded(fieldLimitOf(failure));
        }
        resolve({ ok: false, formError: !inFormula, error: failure });
      };
      const done = (saved: FieldDto | null) => {
        if (saved !== null) announceBackfill(saved);
        resolve({ ok: true });
        onClose();
      };
      if (field === undefined) {
        create.mutate(
          { body: createBody(next), index, count: fieldCount },
          { onSuccess: done, onError: failed },
        );
        return;
      }
      const body = updateBody(field, next);
      if (body === null) {
        done(null);
        return;
      }
      update.mutate({ fieldId: field.id, body }, { onSuccess: done, onError: failed });
    });
  };

  /**
   * (T525) "Create an automation for this button" on a new field: the field
   * is created first (the trigger names it); the card then opens the
   * builder with `button.clicked` on it. `null`: not created (form errors
   * shown, or the server refused).
   */
  const saveButtonField = () =>
    new Promise<FieldDto | null>((resolve) => {
      setSubmitted(true);
      if (field !== undefined || issues.length > 0) {
        resolve(null);
        return;
      }
      create.mutate(
        { body: createBody(draft), index, count: fieldCount },
        {
          onSuccess: (created) => {
            resolve(created);
          },
          onError: (failure) => {
            if (isApiError(failure) && failure.code === 'FIELD_LIMIT_EXCEEDED') {
              onLimitExceeded(fieldLimitOf(failure));
            }
            resolve(null);
          },
        },
      );
    });

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    save();
  };

  // Formula (T466) and lookup (T467) are offered only when the route gives their editors.
  const creatable = CREATABLE_TYPES.filter(
    (type) =>
      (type !== 'formula' || Formula !== undefined) &&
      (type !== 'lookup' || LookupEditor !== undefined),
  );

  // Lookup fields (T467): their own dialog (board "S4b · Cấu hình tra cứu"); this one saves.
  if (draft.type === 'lookup' && LookupEditor !== undefined) {
    // (T469) A saved field of another type becoming a lookup: the editor starts empty,
    // saving previews the conversion and asks to confirm it (`ComputedConversionDialog`).
    const toLookup = field !== undefined && field.type !== 'lookup';
    if (toLookup && lookupConversion !== null) {
      return (
        <ComputedConversionDialog
          field={field}
          tableId={tableId}
          baseId={baseId}
          request={computedConversionRequest('lookup', lookupConversion)}
          onBack={() => {
            setLookupConversion(null);
          }}
          onDone={onClose}
        />
      );
    }
    const saveLookup = (options: Readonly<Record<string, unknown>> | null) => {
      const trimmed = draft.name.trim();
      const text = draft.description.trim();
      if (toLookup) {
        if (options !== null) setLookupConversion(options);
        return;
      }
      if (field === undefined) {
        if (options === null) return;
        create.mutate(
          {
            body: {
              name: trimmed,
              type: 'lookup',
              options: { ...options },
              ...(text === '' ? {} : { description: text }),
            },
            index,
            count: fieldCount,
          },
          {
            onSuccess: onClose,
            onError: (failure) => {
              if (isApiError(failure) && failure.code === 'FIELD_LIMIT_EXCEEDED') {
                onLimitExceeded(fieldLimitOf(failure));
              }
            },
          },
        );
        return;
      }
      const body: Record<string, unknown> = {};
      if (trimmed !== field.name) body['name'] = trimmed;
      if (text !== (field.description ?? '')) body['description'] = text === '' ? null : text;
      if (options !== null) body['options'] = options;
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
      update.mutate({ fieldId: field.id, body }, { onSuccess: onClose });
    };
    const lookupMutation = field === undefined ? create : update;
    return (
      <LookupEditor
        tableId={tableId}
        field={toLookup ? undefined : field}
        convertingFieldId={toLookup ? field.id : undefined}
        name={draft.name}
        description={draft.description}
        onNameChange={(value) => {
          change({ name: value });
        }}
        onDescriptionChange={(value) => {
          change({ description: value });
        }}
        typePicker={
          <TypePicker
            creatable={creatable}
            field={field}
            value={draft.type}
            onChange={(type) => {
              change({ type });
            }}
          />
        }
        onSave={saveLookup}
        saving={lookupMutation.isPending}
        saveError={lookupMutation.error}
        onClose={onClose}
      />
    );
  }

  // Two-way → one-way (T415): its own dialog, which side stays (board "Tắt liên kết hai chiều").
  if (field !== undefined && linkChange === 'to_one_way' && linkedTable !== undefined) {
    return (
      <DisableTwoWayDialog
        field={field}
        tableId={tableId}
        tableName={thisTable?.name ?? ''}
        baseId={baseId}
        linkedTable={linkedTable}
        onCancel={() => {
          change({ link: { ...draft.link, bidirectional: true } });
        }}
        onClose={onClose}
      />
    );
  }

  const wide = previewBody !== null && !converting;
  const mode = paneModeOf(field, draft, styleCheck !== null);
  const settingsKind =
    field === undefined || draft.type === field.type
      ? null
      : settingsKindOf(sourceTypeOf(field, draft.type), draft.type);

  const optionsForm = (() => {
    switch (draft.type) {
      case 'text':
        return (
          <TextOptionsForm
            value={draft.text}
            onChange={(text) => {
              change({ text });
            }}
          />
        );
      case 'number':
        return (
          <NumberOptionsForm
            value={draft.number}
            issues={optionIssues}
            defaultCurrency={currency ?? (format.locale.startsWith('vi') ? 'VND' : 'USD')}
            onChange={(number) => {
              change({ number });
            }}
          />
        );
      case 'select':
        return (
          <SelectOptionsEditor
            value={draft.select}
            issues={optionIssues}
            onChange={(select) => {
              change({ select });
            }}
          />
        );
      case 'datetime':
        return (
          <>
            <DatetimeOptionsForm
              value={draft.datetime}
              onChange={(datetime) => {
                change({ datetime });
              }}
            />
            {/* (T554) Not while converting another type: set up once it is a date field. */}
            {field === undefined || field.type === 'datetime' ? (
              <ReminderSection
                value={draft.reminder}
                onChange={(reminder) => {
                  change({ reminder });
                }}
                tableId={tableId}
                orgId={orgId}
                dateOnly={isDateOnlyFormat(draft.datetime.style.format)}
                fieldTimeZone={draft.datetime.timezone}
                issues={reminderIssues}
                canManage={base === undefined || canManageSchema(base.access, tableId)}
                now={now}
              />
            ) : null}
          </>
        );
      case 'user':
        return (
          <UserOptionsForm
            value={draft.user}
            onChange={(user) => {
              change({ user });
            }}
          />
        );
      case 'created_at':
      case 'updated_at':
        return (
          <SystemTimeOptionsForm
            value={draft.systemTime}
            onChange={(systemTime) => {
              change({ systemTime });
            }}
          />
        );
      case 'auto_number':
        return (
          <AutoNumberRulesBuilder
            value={draft.autoNumber}
            issues={optionIssues}
            timeZone={format.timeZone}
            existing={editing}
            onChange={(autoNumber) => {
              change({ autoNumber });
            }}
          />
        );
      case 'link':
        return (
          <LinkOptionsForm
            value={draft.link}
            tables={field?.type === 'link' ? tables.all : tables.linkable}
            editing={editing}
            issues={optionIssues}
            orgId={orgId}
            RecordFilterEditor={RecordFilterEditor}
            tableName={thisTable?.name}
            twoWayLocked={twoWayLocked}
            saved={field?.type === 'link' ? draftOf(field).link : undefined}
            partnerName={partnerName}
            onChange={(link) => {
              change({ link });
            }}
          />
        );
      case 'attachment':
        return (
          <AttachmentOptionsForm
            value={draft.attachment}
            issues={optionIssues}
            onChange={(attachment) => {
              change({ attachment });
            }}
          />
        );
      case 'formula':
        return Formula === undefined ? (
          <p className="text-label font-normal text-fg-muted">{t('field:formula.unavailable')}</p>
        ) : (
          <Suspense fallback={<Spinner />}>
            <Formula
              tableId={tableId}
              // A field becoming a formula (T469) is not one yet: no definition, no `field_id`.
              field={field?.type === 'formula' ? field : undefined}
              fieldName={draft.name.trim()}
              value={draft.formula}
              onChange={(formula) => {
                change({ formula });
              }}
              onSave={saveFormula}
              missing={issueAt(shownIssues, 'options.expression') !== undefined}
            />
          </Suspense>
        );
      case 'button':
        return (
          <ButtonOptionsForm
            value={draft.button}
            name={draft.name}
            issues={optionIssues}
            onChange={(button) => {
              change({ button });
            }}
            automation={
              <AutomationCard
                base={base}
                tableId={tableId}
                field={field?.type === 'button' ? field : undefined}
                label={buttonLabelOf(draft)}
                saveField={saveButtonField}
                onLeave={onClose}
                creating={create.isPending}
              />
            }
          />
        );
      // Lookup without its editor (not given by the route): nothing to configure here.
      case 'checkbox':
      case 'created_by':
      case 'updated_by':
      case 'lookup':
        return <p className="text-label font-normal text-fg-muted">{t('field:noOptions')}</p>;
    }
  })();

  const targetOptions =
    draft.type === 'select'
      ? draft.select.options
          .filter((option) => !option.deleted)
          .map((option) => ({ name: option.name.trim(), color: option.color }))
      : undefined;
  const submitLabel =
    convertRequest === null
      ? editing
        ? t('field:dialog.save')
        : t('field:dialog.create')
      : mode === 'type' && isComputedType(draft.type)
        ? t('field:convert.submit.toComputed', { type: t(`field:types.${draft.type}`) })
        : mode === 'type' && field !== undefined && isComputedType(field.type)
          ? t('field:convert.submit.static')
          : t(`field:convert.submit.${mode}`);
  const busy = mutation.isPending || (convertRequest !== null && update.isPending);
  const typeConversion = mode === 'type' && convertRequest !== null;

  const nameInput = (
    <FormField label={t('field:name')} error={issueText(nameIssue)}>
      {(control) => (
        <Input
          {...control}
          autoComplete="off"
          maxLength={255}
          value={draft.name}
          onChange={(event) => {
            change({ name: event.target.value });
          }}
        />
      )}
    </FormField>
  );
  const typePicker = (
    <TypePicker
      creatable={creatable}
      field={field}
      value={draft.type}
      disabled={converting}
      onChange={(type) => {
        change({ type });
      }}
    />
  );
  const flags =
    !typeConversion && (REQUIRABLE_TYPES.has(draft.type) || UNIQUE_TYPES.has(draft.type)) ? (
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        {REQUIRABLE_TYPES.has(draft.type) ? (
          <Checkbox
            label={t('field:required')}
            hint={t('field:requiredHint')}
            checked={draft.required}
            onChange={(event) => {
              change({ required: event.target.checked });
            }}
          />
        ) : null}
        {UNIQUE_TYPES.has(draft.type) ? (
          <Checkbox
            label={t('field:unique')}
            hint={t('field:uniqueHint')}
            checked={draft.unique}
            onChange={(event) => {
              change({ unique: event.target.checked });
            }}
          />
        ) : null}
      </div>
    ) : null;
  const descriptionInput = typeConversion ? null : (
    <FormField label={t('field:description')} error={issueText(descriptionIssue)}>
      {(control) => (
        <textarea
          {...control}
          rows={2}
          maxLength={2000}
          className={TEXTAREA_CLASSES}
          value={draft.description}
          onChange={(event) => {
            change({ description: event.target.value });
          }}
        />
      )}
    </FormField>
  );

  const convertingNotice = converting ? (
    <Alert variant="info" data-testid="field-converting">
      <p>{t('field:convert.busy')}</p>
    </Alert>
  ) : null;
  const errors = (
    <>
      {locked ? (
        <Alert variant="danger">
          <p>{t('field:locked')}</p>
          <div>
            <Button variant="secondary" size="sm" onClick={save}>
              {t('field:retry')}
            </Button>
          </div>
        </Alert>
      ) : null}
      {blocked ||
      (isApiError(error) && error.code === 'CONVERSION_NOT_ALLOWED' && convertRequest === null) ? (
        <Alert variant="info">
          <p>{t('field:conversionSoon')}</p>
        </Alert>
      ) : null}
      {otherError === null ? null : <ErrorAlert error={otherError} />}
      {(submitted && issues.length > 0 && issues.some((issue) => issue.path !== 'name')) ||
      reminderOnly ? (
        <p role="alert" className="text-label font-normal text-danger">
          {t('field:fixErrors')}
        </p>
      ) : null}
    </>
  );

  if (!wide) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={editing ? t('field:dialog.editTitle') : t('field:dialog.createTitle')}
        closeLabel={t('common:actions.close')}
        className="max-w-3xl"
      >
        <form noValidate className="flex flex-col gap-4" onSubmit={onSubmit}>
          {convertingNotice}
          <div
            className={cn(
              'grid gap-6',
              draft.type !== 'formula' && 'md:grid-cols-[minmax(0,1fr)_15rem]',
            )}
          >
            <div className="flex min-w-0 flex-col gap-4">
              {nameInput}
              {typePicker}
              <fieldset className="flex min-w-0 flex-col gap-4 border-t border-line pt-4">
                <legend className="sr-only">{t('field:optionsLegend')}</legend>
                {optionsForm}
              </fieldset>
              {flags}
              {descriptionInput}
            </div>
            {draft.type === 'formula' ? null : (
              <FieldPreview
                config={config}
                type={draft.type}
                name={draft.name}
                locale={locale}
                userName={me.data?.user.display_name ?? ''}
                now={now}
                button={draft.type === 'button' ? draft.button : undefined}
              />
            )}
          </div>
          {errors}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending || blocked || converting}>
              {mutation.isPending ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  // A conversion or a style check: the board's two panes, the preview on the right.
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {t('field:dialog.editTitle')}
          {thisTable === undefined ? null : (
            <span className="text-label font-normal text-fg-muted">
              {t('field:convert.tableOf', { table: thisTable.name })}
            </span>
          )}
        </span>
      }
      closeLabel={t('common:actions.close')}
      className="max-w-[1000px]"
    >
      <form noValidate className="flex flex-col" onSubmit={onSubmit}>
        <div className="-mx-6 grid border-y border-line md:grid-cols-[minmax(0,380px)_minmax(0,1fr)] md:max-h-[min(680px,calc(100dvh-12rem))] md:overflow-hidden">
          <div className="flex min-w-0 flex-col gap-4 p-5 md:border-r md:border-line md:overflow-y-auto">
            {nameInput}
            {typePicker}
            <fieldset className="flex min-w-0 flex-col gap-4">
              <legend className="sr-only">{t('field:optionsLegend')}</legend>
              {optionsForm}
            </fieldset>
            {settingsKind === null ? null : (
              <ConversionSettingsForm kind={settingsKind} value={settings} onChange={setSettings} />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-4 bg-surface-sunken/40 p-5 md:overflow-y-auto">
            <ConversionPane
              mode={mode}
              tableId={tableId}
              baseId={baseId}
              targetType={draft.type}
              targetLabel={t(`field:types.${draft.type}`)}
              {...(targetOptions === undefined ? {} : { targetOptions })}
              {...(draft.type === 'text' &&
              (draft.text.style.type === 'email' || draft.text.style.type === 'phone')
                ? { style: draft.text.style.type }
                : {})}
              preview={preview}
              loading={previewState.loading}
              stale={previewState.stale}
              error={previewState.error}
              onRetry={previewState.retry}
              required={convertRequest === null ? null : required}
              consents={consents}
              onConsents={setConsents}
              linkedTable={linkedTable}
              tableName={thisTable?.name}
              fromComputed={field !== undefined && isComputedType(field.type)}
            />
            {errors}
          </div>
        </div>
        <div className="-mx-6 -mb-6 flex flex-wrap items-center gap-2 px-5 py-3">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label font-normal text-fg-muted">
            {convertRequest === null ? null : (
              <>
                <History aria-hidden="true" className="size-3.5 shrink-0" />
                {t(mode === 'to_two_way' ? 'field:convert.footerLink' : 'field:convert.footer')}
              </>
            )}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            type="submit"
            className={cn(convertRequest !== null && 'min-w-28')}
            disabled={busy || !conversionReady}
            data-testid="field-dialog-submit"
          >
            {busy ? <Spinner /> : null}
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
