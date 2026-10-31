import type { FieldDto } from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * The prompt editor of an AI field (T915): the automation template editor
 * (`features/automation/template-editor`, field chips, "+" menu, `{{` to
 * insert) given to the field dialog by the route, since features do not
 * import each other (FRONTEND §1.2). The prompt is the field API's form:
 * field names in placeholders (`{{ [Mô tả] }}`, CONTRACTS §29.5).
 */
export interface AiPromptEditorProps {
  /** Fields the prompt may name (same record; never the field itself nor another AI field). */
  readonly fields: readonly FieldDto[];
  /** Name of the table, for the heading of the "+" menu. */
  readonly tableName: string;
  /** The prompt with field names (`{{ [Name] }}`). */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
  readonly testId?: string | undefined;
}

export type AiPromptEditorComponent = ComponentType<AiPromptEditorProps>;
