import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { TemplateInput, type ChipLabel } from '../builder/components/values/TemplateInput';

import type { AiPromptEditorProps } from '../../../lib/schema/ai-tools';
import type { PickerSection } from '../builder/components/values/ValuePicker';

/** `[Name]` → `Name` (`\]` and `\\` unescaped); `null` for anything else. */
function nameOf(expression: string): string | null {
  const match = /^\[((?:[^\]\\]|\\.)*)\]$/u.exec(expression.trim());
  return match === null ? null : (match[1] ?? '').replace(/\\(.)/gu, '$1');
}

function bracketName(name: string): string {
  return `[${name.replace(/[\\\]]/gu, (char) => `\\${char}`)}]`;
}

/**
 * The prompt of an AI field (T915, FRONTEND §4.10): the builder's template
 * field (chips, "+" menu, `{{` opens it, a chip goes whole on Backspace)
 * over the field API's names form — a chip is `{{ [Mô tả] }}`, named by the
 * field; a name no field has any more, or `#REF[fld_…]` (a field the reader
 * cannot read or that was deleted), is a red chip. Enter adds a line, never
 * submits the field dialog's form around it.
 */
export function AiPromptEditor({
  fields,
  tableName,
  value,
  onChange,
  label,
  placeholder,
  invalid,
  describedBy,
  testId,
}: AiPromptEditorProps) {
  const { t } = useTranslation('automationBuilder');
  const names = useMemo(() => new Set(fields.map((field) => field.name)), [fields]);
  const chipLabel = useCallback(
    (expression: string): ChipLabel => {
      const name = nameOf(expression);
      if (name !== null && names.has(name)) return { text: name, tone: 'field' };
      if (name !== null) return { text: name, tone: 'error' };
      return expression.trim().startsWith('#REF')
        ? { text: t('chip.ref'), tone: 'error' }
        : { text: expression.trim(), tone: 'expression' };
    },
    [names, t],
  );
  const sections = useMemo<PickerSection[]>(
    () => [
      {
        key: 'record',
        title: t('picker.record', { table: tableName }),
        items: fields.map((field) => ({
          key: field.id,
          label: field.name,
          tone: 'field' as const,
          pick: { kind: 'ref' as const, expression: bracketName(field.name) },
        })),
      },
    ],
    [fields, tableName, t],
  );
  return (
    <TemplateInput
      value={value}
      onChange={onChange}
      chipLabel={chipLabel}
      sections={sections}
      label={label}
      multiline
      invalid={invalid}
      describedBy={describedBy}
      placeholder={placeholder}
      testId={testId}
    />
  );
}

export default AiPromptEditor;
