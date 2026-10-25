import {
  DEFAULT_DIGEST_ROWS,
  EMAIL_BODY_DIGEST_REFERENCE,
  MAX_DIGEST_ROWS,
  type AutomationDefinition,
  type SendEmailConfig,
} from '@cellhive/contracts';
import { Input, Select, Switch } from '@cellhive/ui';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useBuilderEnv } from '../../components/env';
import { useChipText } from '../../components/values/chips';
import { TemplateInput } from '../../components/values/TemplateInput';
import { earlierActions, isUnset } from '../../model/draft';
import { chipNameOf, type ValueScope } from '../../model/scope';
import { referenceExpression } from '../../model/values';

import type { PickerSection } from '../../components/values/ValuePicker';

const TEST_EMAIL_DIGEST_ROW = 'email-digest-row';

/** The placeholder of the `digest` lines in the body (`{{ [@digest] }}`). */
export const DIGEST_EXPRESSION = `[${EMAIL_BODY_DIGEST_REFERENCE}]`;
export const DIGEST_PLACEHOLDER = `{{ ${DIGEST_EXPRESSION} }}`;

type Body = SendEmailConfig['body'];

export interface DigestSettingsProps {
  readonly actionId: string;
  readonly definition: AutomationDefinition;
  readonly body: Body;
  readonly onChange: (body: Body) => void;
  readonly scope: ValueScope;
}

/**
 * "List of records" of the body (`digest`, SPEC §11.4; board toolbar
 * "Bảng cho danh sách bản ghi"): one line per record an earlier
 * `find_records` step found, written by a row template on that step's
 * fields, where the body says `{{ [@digest] }}` (the chip "Danh sách bản
 * ghi"). Only offered when such a step comes before.
 */
export function DigestSettings({
  actionId,
  definition,
  body,
  onChange,
  scope,
}: DigestSettingsProps) {
  const { t } = useTranslation('automationEmail');
  const env = useBuilderEnv();
  const chipText = useChipText();
  const id = useId();
  const finds = earlierActions(definition, actionId).filter(
    ({ action }) => action.type === 'find_records' && !isUnset(action.config.table_id),
  );
  if (finds.length === 0 && body.digest === null) return null;
  const digest = body.digest;
  const source = finds.find(({ action }) => action.id === digest?.step)?.action;
  const tableId = source?.type === 'find_records' ? source.config.table_id : null;
  const tableFields = tableId === null ? [] : (env.fieldsOf(tableId) ?? []);
  const returned =
    source?.type === 'find_records' && source.config.fields.length > 0
      ? tableFields.filter((field) => source.config.fields.includes(field.id))
      : tableFields.filter(
          (field) =>
            field.id === env.tables.find((table) => table.id === tableId)?.primary_field_id,
        );
  const rowScope: ValueScope = {
    triggerType: scope.triggerType,
    triggerTableId: tableId,
    steps: [],
  };
  const sections: PickerSection[] = [
    {
      key: 'row',
      title: t('digest.rowFields'),
      items: returned.map((field) => ({
        key: `row:${field.id}`,
        label: field.name,
        tone: 'field' as const,
        pick: {
          kind: 'ref' as const,
          expression: referenceExpression({ kind: 'field', fieldId: field.id }),
        },
      })),
    },
  ];

  const turnOn = (on: boolean) => {
    if (!on) {
      onChange({
        ...body,
        digest: null,
        template: body.template.replaceAll(DIGEST_PLACEHOLDER, '').trimEnd(),
      });
      return;
    }
    const first = finds[0]?.action;
    if (first === undefined) return;
    onChange({
      ...body,
      digest: { step: first.id, row_template: '', max_rows: DEFAULT_DIGEST_ROWS, separator: '\n' },
      template: body.template.includes(DIGEST_PLACEHOLDER)
        ? body.template
        : `${body.template.trimEnd()}${body.template.trim() === '' ? '' : '\n\n'}${DIGEST_PLACEHOLDER}`,
    });
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line p-3"
      data-testid="email-digest"
    >
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-on`}
          checked={digest !== null}
          onChange={(event) => {
            turnOn(event.target.checked);
          }}
        />
        <label htmlFor={`${id}-on`} className="text-body">
          {t('digest.toggle')}
        </label>
      </div>
      {digest === null ? (
        <p className="text-label font-normal text-fg-muted">{t('digest.hint')}</p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2 max-sm:grid-cols-1">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-step`} className="text-label text-fg">
                {t('digest.step')}
              </label>
              <Select
                id={`${id}-step`}
                value={digest.step}
                onChange={(event) => {
                  onChange({
                    ...body,
                    digest: { ...digest, step: event.target.value, row_template: '' },
                  });
                }}
              >
                {finds.map(({ action, number }) => (
                  <option key={action.id} value={action.id}>
                    {t('digest.stepOption', {
                      number,
                      table:
                        action.type === 'find_records'
                          ? (env.tableName(action.config.table_id) ?? '')
                          : '',
                    })}
                  </option>
                ))}
                {source === undefined ? (
                  <option value={digest.step}>{t('digest.missingStep')}</option>
                ) : null}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-max`} className="text-label text-fg">
                {t('digest.maxRows')}
              </label>
              <Input
                id={`${id}-max`}
                type="number"
                min={1}
                max={MAX_DIGEST_ROWS}
                value={String(digest.max_rows)}
                onChange={(event) => {
                  const next = event.target.valueAsNumber;
                  if (!Number.isInteger(next)) return;
                  onChange({
                    ...body,
                    digest: { ...digest, max_rows: Math.min(MAX_DIGEST_ROWS, Math.max(1, next)) },
                  });
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-label text-fg">{t('digest.row')}</span>
            <TemplateInput
              value={digest.row_template}
              onChange={(row_template) => {
                onChange({ ...body, digest: { ...digest, row_template } });
              }}
              chipLabel={(expression) => {
                const name = chipNameOf(expression, rowScope, env);
                return { text: chipText(name), tone: name.tone };
              }}
              sections={sections}
              label={t('digest.row')}
              testId={TEST_EMAIL_DIGEST_ROW}
            />
            <p className="text-label font-normal text-fg-muted">{t('digest.rowHint')}</p>
          </div>
        </>
      )}
    </div>
  );
}
