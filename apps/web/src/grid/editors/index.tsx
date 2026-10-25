import { FIELD_TYPE_REGISTRY } from '@cellhive/field-types';

import { AttachmentEditor } from './attachment';
import { DatetimeEditor } from './datetime';
import { NumberEditor } from './number';
import { SelectEditor } from './select';
import { TextEditor } from './text';
import { UserEditor } from './user';

import type { CellEditorProps } from './types';
import type { GridField } from '../types';
import type { FieldConfig } from '@cellhive/field-types';

export * from './types';

/**
 * Whether a field type can be written at all (SPEC §5.5): system types
 * (`created_*`, `updated_*`), `auto_number` and the types without an S1
 * renderer (link, lookup… — S4) are read-only for everyone. Permissions are
 * checked separately (`lib/permissions`, FRONTEND §7).
 */
export function isEditableField(field: GridField): boolean {
  // Link (T413): written through the link picker, not an overlay editor.
  if (field.link !== undefined) return true;
  const config = field.config;
  return config !== null && !FIELD_TYPE_REGISTRY[config.type].readOnly;
}

/** Link fields (T413): their cells open the link picker (`hooks.link`) instead of an overlay editor. */
export function editsWithPicker(field: GridField): boolean {
  return field.link !== undefined;
}

/** Types edited in place, without an overlay: a click or Space toggles the check box. */
export function editsInPlace(field: GridField): boolean {
  return field.config?.type === 'checkbox';
}

/**
 * Types whose overlay editor takes typed text (an input, a search box):
 * keys typed while it opens are kept for it (`TypeToEdit`, T803).
 */
export function editorTakesTyping(field: GridField): boolean {
  const type = field.config?.type;
  return (
    type === 'text' ||
    type === 'number' ||
    type === 'select' ||
    type === 'datetime' ||
    type === 'user'
  );
}

type AnyEditorProps = Omit<CellEditorProps, 'config'> & { readonly config: FieldConfig };

/** The overlay editor of a field type (`grid/editors/<type>.tsx`). */
export function CellEditor(props: AnyEditorProps) {
  const { config } = props;
  switch (config.type) {
    case 'text':
      return <TextEditor {...props} config={config} />;
    case 'number':
      return <NumberEditor {...props} config={config} />;
    case 'select':
      return <SelectEditor {...props} config={config} />;
    case 'datetime':
      return <DatetimeEditor {...props} config={config} />;
    case 'user':
      return <UserEditor {...props} config={config} />;
    case 'attachment':
      return <AttachmentEditor {...props} config={config} />;
    default:
      return null;
  }
}
