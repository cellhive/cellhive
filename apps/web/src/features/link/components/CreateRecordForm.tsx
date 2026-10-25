import { newId, type FieldDto, type RecordDto } from '@cellhive/contracts';
import { Button, cn, Input, Select } from '@cellhive/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cellClipboardText } from '../../../grid/clipboard';
import { datetimeDraft, numberDraft, selectDraft, textDraft } from '../../../grid/editors/parse';
import { toGridField } from '../../../grid/types';
import { api } from '../../../lib/api';
import { ApiError } from '../../../lib/api/client';
import { translateDetail, translateError } from '../../../lib/errors/translate';

import type { EditorDraft } from '../../../grid/editors/types';
import type { LinkRef } from '../../../lib/links/values';
import type { LocaleContext } from '@cellhive/field-types';

/** Types the short form can fill in (others, when required, send the user to the table). */
const FORM_TYPES = new Set(['text', 'number', 'select', 'datetime', 'checkbox']);

function hasDefault(field: FieldDto): boolean {
  const fallback = (field.options as { default_value?: unknown } | null)?.default_value;
  return fallback !== undefined && fallback !== null;
}

/**
 * Fields "Create a record" of the picker asks for (T413): the primary
 * field (filled with the search), then the required fields without a
 * default value that the user may set on creation. `unsupported`: required
 * fields of types this short form cannot fill in.
 */
export function createFormFields(
  fields: readonly FieldDto[],
  canSet: (fieldId: string) => boolean,
): { readonly inputs: FieldDto[]; readonly unsupported: FieldDto[] } {
  const primary = fields.find((field) => field.is_primary);
  const inputs: FieldDto[] = [];
  const unsupported: FieldDto[] = [];
  if (primary !== undefined && primary.type === 'text' && canSet(primary.id)) inputs.push(primary);
  for (const field of fields) {
    if (field.is_primary || !field.required || hasDefault(field)) continue;
    if (FORM_TYPES.has(field.type) && canSet(field.id)) inputs.push(field);
    else unsupported.push(field);
  }
  return { inputs, unsupported };
}

/** Whether creating needs the short form (a required field besides the primary). */
export function needsForm(inputs: readonly FieldDto[]): boolean {
  return inputs.some((field) => !field.is_primary);
}

function draftFor(field: FieldDto, text: string, locale: LocaleContext): EditorDraft {
  const config = toGridField(field).config;
  switch (config?.type) {
    case 'text':
      return textDraft(text, config.options);
    case 'number':
      return numberDraft(text, config.options, locale);
    case 'datetime':
      return datetimeDraft(text, config.options, locale);
    case 'select':
      return selectDraft(text === '' ? [] : [text], config.options, false);
    case 'checkbox':
      return {
        ok: true,
        commit: { value: text === 'true', display: text === 'true', typecast: false },
      };
    default:
      return {
        ok: true,
        commit: { value: text === '' ? null : text, display: text, typecast: true },
      };
  }
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Creates a record of the linked table and returns it as a linked record. */
export async function createLinkedRecord(
  linkTable: string,
  values: Readonly<Record<string, unknown>>,
  primary: FieldDto | undefined,
  locale: LocaleContext,
): Promise<LinkRef> {
  const response = await api.records.create(linkTable, [{ fields: values }], {
    idempotencyKey: newId('req'),
  });
  const record: RecordDto | undefined = response.records[0];
  if (record === undefined) {
    // Created, but outside what the user reads (a read rule): it cannot be linked by them.
    throw new ApiError({ status: 404, code: 'NOT_FOUND' });
  }
  const title =
    primary === undefined
      ? ''
      : cellClipboardText(toGridField(primary), record.fields[primary.id] ?? null, locale);
  return { id: record.id, title };
}

export interface CreateRecordFormProps {
  readonly linkTable: string;
  readonly tableName: string;
  readonly inputs: readonly FieldDto[];
  readonly unsupported: readonly FieldDto[];
  readonly primary: FieldDto | undefined;
  readonly initialName: string;
  readonly locale: LocaleContext;
  readonly onCreated: (ref: LinkRef) => void;
  readonly onCancel: () => void;
}

/**
 * The short form of "Create a record" (board: "Mở form ngắn, tự gắn liên
 * kết"): the primary field and the required fields, validated like the
 * grid editors, then `POST …/records` and the new record is selected.
 */
export function CreateRecordForm(props: CreateRecordFormProps) {
  const { t, i18n } = useTranslation('link');
  const formId = useId();
  const first = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    props.primary === undefined ? {} : { [props.primary.id]: props.initialName },
  );
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    first.current?.focus();
  }, []);

  if (props.unsupported.length > 0) {
    return (
      <div className="flex flex-col gap-3 p-4" role="alert">
        <p className="text-body text-fg">
          {t('create.unsupported', {
            table: props.tableName,
            fields: props.unsupported.map((field) => field.name).join(', '),
          })}
        </p>
        <div>
          <Button variant="secondary" onClick={props.onCancel}>
            {t('create.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    const values: Record<string, unknown> = {};
    const found: Record<string, string> = {};
    let typecast = false;
    for (const field of props.inputs) {
      const draft = draftFor(field, texts[field.id] ?? '', props.locale);
      if (!draft.ok) {
        found[field.id] = translateDetail(i18n, draft.issue);
        continue;
      }
      if (field.required && isEmptyValue(draft.commit.value)) {
        found[field.id] = t('create.required');
        continue;
      }
      typecast ||= draft.commit.typecast;
      if (draft.commit.value !== null) values[field.id] = draft.commit.value;
    }
    setIssues(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      props.onCreated(
        await createLinkedRecord(props.linkTable, values, props.primary, props.locale),
      );
    } catch (error) {
      const translated = translateError(error, i18n);
      setFailure(
        [translated.message, ...translated.details.map((detail) => detail.message)].join(' '),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      id={formId}
      aria-label={t('create.title', { table: props.tableName })}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-heading">{t('create.title', { table: props.tableName })}</h3>
      {props.inputs.map((field, index) => {
        const inputId = `${formId}-${field.id}`;
        const issueId = `${inputId}-issue`;
        const issue = issues[field.id];
        const config = toGridField(field).config;
        const common = {
          id: inputId,
          'aria-invalid': issue !== undefined,
          'aria-describedby': issue === undefined ? undefined : issueId,
          'aria-required': field.required || undefined,
        };
        const value = texts[field.id] ?? '';
        const set = (next: string) => {
          setTexts((current) => ({ ...current, [field.id]: next }));
        };
        let control;
        if (config?.type === 'select') {
          control = (
            <Select
              {...common}
              ref={index === 0 ? (element) => void (first.current = element) : undefined}
              value={value}
              onChange={(event) => {
                set(event.target.value);
              }}
            >
              <option value="">{t('create.choose')}</option>
              {config.options.options.map((option) => (
                <option key={option.id} value={option.name}>
                  {option.name}
                </option>
              ))}
            </Select>
          );
        } else if (config?.type === 'checkbox') {
          control = (
            <label className="inline-flex min-h-control items-center gap-2 lg:min-h-8">
              <input
                {...common}
                type="checkbox"
                className="size-4"
                checked={value === 'true'}
                onChange={(event) => {
                  set(event.target.checked ? 'true' : '');
                }}
              />
              {t('create.yes')}
            </label>
          );
        } else {
          control = (
            <Input
              {...common}
              ref={index === 0 ? (element) => void (first.current = element) : undefined}
              value={value}
              autoComplete="off"
              onChange={(event) => {
                set(event.target.value);
              }}
            />
          );
        }
        return (
          <div key={field.id} className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-label text-fg">
              {field.name}
              {field.required ? (
                <span className="text-danger" aria-hidden="true">
                  {' '}
                  *
                </span>
              ) : null}
            </label>
            {control}
            {issue === undefined ? null : (
              <p id={issueId} className="text-label font-normal text-danger">
                {issue}
              </p>
            )}
          </div>
        );
      })}
      {failure === null ? null : (
        <p role="alert" className={cn('text-label font-normal text-danger')}>
          {failure}
        </p>
      )}
      <div className="mt-auto flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={props.onCancel} disabled={busy}>
          {t('create.cancel')}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? t('create.creating') : t('create.submit')}
        </Button>
      </div>
    </form>
  );
}
