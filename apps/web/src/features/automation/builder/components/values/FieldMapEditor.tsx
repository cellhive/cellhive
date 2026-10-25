import { isComputedFieldType, getFieldType } from '@cellhive/field-types';
import { Button, Select, Tooltip } from '@cellhive/ui';
import { CircleAlert, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { issuesAt, type BuilderIssue, type StepKey } from '../../model/issues';
import { useIssueText } from '../issue-text';

import { ValueInput } from './ValueInput';

import type { ValueScope } from '../../model/scope';
import type { AutomationFieldValues, AutomationValue, FieldDto } from '@cellhive/contracts';

/** Fields an action can write: not computed, not read-only by type (CONTRACTS §2). */
export function writableFields(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) => {
    if (isComputedFieldType(field.type)) return false;
    const definition = getFieldType(field.type);
    return definition !== undefined && !definition.readOnly;
  });
}

export interface FieldMapEditorProps {
  readonly step: StepKey;
  /** Path of the map in the step (`config.fields`). */
  readonly path: string;
  readonly fields: readonly FieldDto[];
  readonly value: AutomationFieldValues;
  readonly onChange: (value: AutomationFieldValues) => void;
  readonly scope: ValueScope;
  readonly issues: readonly BuilderIssue[];
}

/**
 * "Set values" of `create_record` / `update_record` (SPEC §11.5): one row
 * per field written — the field, then its value (text with chips, a
 * constant by type, or a source) — and a select to add a field. A field
 * whose value is still empty is kept here but not saved.
 */
export function FieldMapEditor({
  step,
  path,
  fields,
  value,
  onChange,
  scope,
  issues,
}: FieldMapEditorProps) {
  const { t } = useTranslation('automationBuilder');
  const issueText = useIssueText();
  const addId = useId();
  const writable = writableFields(fields);
  const entries = Object.entries(value) as [string, AutomationValue | undefined][];
  const unused = writable.filter((field) => !(field.id in value));
  const set = (fieldId: string, next: AutomationValue | undefined) => {
    onChange({ ...value, [fieldId]: next });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="field-map">
      {entries.length === 0 ? (
        <p className="text-label font-normal text-fg-muted">{t('fieldMap.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map(([fieldId, item]) => {
            const field = fields.find((candidate) => candidate.id === fieldId) ?? null;
            const rowIssues = issuesAt(issues, step, `${path}.${fieldId}`);
            const messageId = `${addId}-${fieldId}`;
            const name = field?.name ?? t('chip.ref');
            return (
              <li
                key={fieldId}
                className="flex flex-col gap-1"
                data-testid={`field-map-row-${fieldId}`}
              >
                <div className="flex items-center gap-1">
                  <span
                    className={
                      field === null
                        ? 'min-w-0 flex-1 truncate text-label text-danger'
                        : 'min-w-0 flex-1 truncate text-label text-fg'
                    }
                  >
                    {name}
                  </span>
                  <Tooltip content={t('fieldMap.remove', { field: name })}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 max-lg:size-control"
                      aria-label={t('fieldMap.remove', { field: name })}
                      onClick={() => {
                        onChange(
                          Object.fromEntries(
                            Object.entries(value).filter(([key]) => key !== fieldId),
                          ),
                        );
                      }}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </Tooltip>
                </div>
                <ValueInput
                  value={item}
                  onChange={(next) => {
                    set(fieldId, next);
                  }}
                  field={field}
                  scope={scope}
                  label={t('fieldMap.valueOf', { field: name })}
                  invalid={rowIssues.length > 0}
                  describedBy={rowIssues.length > 0 ? messageId : undefined}
                  testId={`field-value-${fieldId}`}
                />
                {rowIssues.length > 0 ? (
                  <p id={messageId} className="flex items-center gap-1 text-label text-danger">
                    <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                    {rowIssues.map(issueText).join(' ')}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {unused.length === 0 ? null : (
        <Select
          aria-label={t('fieldMap.add')}
          value=""
          data-testid="field-map-add"
          onChange={(event) => {
            const fieldId = event.target.value;
            if (fieldId !== '') set(fieldId, undefined);
          }}
        >
          <option value="">{t('fieldMap.addPlaceholder')}</option>
          {unused.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}
