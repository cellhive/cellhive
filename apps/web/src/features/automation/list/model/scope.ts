import { triggerTableId } from './summary';

import type { AutomationAction, AutomationDefinition } from '@cellhive/contracts';

export interface WriteScope {
  readonly tableId: string;
  /** Fields written, in the order of first use. */
  readonly fields: readonly string[];
  readonly add: boolean;
  readonly delete: boolean;
}

/**
 * What an automation reads and writes (T520, take-over dialog "Permissions
 * used when it runs", ADR-25 §3/§6): the tables it reads (trigger, records
 * looked up or written) and, per written table, the fields and whether it
 * adds or deletes records. Derived from the definition only (pure); the
 * server checks the real permissions of the person taking over.
 */
export interface AutomationScope {
  readonly reads: readonly string[];
  readonly writes: readonly WriteScope[];
}

interface MutableWrite {
  fields: string[];
  add: boolean;
  delete: boolean;
}

export function automationScope(definition: AutomationDefinition): AutomationScope {
  const reads: string[] = [];
  const writes = new Map<string, MutableWrite>();
  const trigger = triggerTableId(definition.trigger);
  const read = (tableId: string | null) => {
    if (tableId !== null && !reads.includes(tableId)) reads.push(tableId);
  };
  const write = (tableId: string | null, fields: readonly string[], kind?: 'add' | 'delete') => {
    if (tableId === null) return;
    read(tableId);
    const entry = writes.get(tableId) ?? { fields: [], add: false, delete: false };
    for (const field of fields) if (!entry.fields.includes(field)) entry.fields.push(field);
    if (kind === 'add') entry.add = true;
    if (kind === 'delete') entry.delete = true;
    writes.set(tableId, entry);
  };
  read(trigger);
  const visit = (actions: readonly AutomationAction[]) => {
    for (const action of actions) {
      switch (action.type) {
        case 'create_record':
          write(action.config.table_id, Object.keys(action.config.fields), 'add');
          break;
        case 'update_record':
        case 'update_records':
          write(action.config.table_id, Object.keys(action.config.fields));
          break;
        case 'find_records':
          read(action.config.table_id);
          break;
        case 'delete_record':
          write(trigger, [], 'delete');
          break;
        case 'if':
          visit(action.config.then);
          visit(action.config.else);
          break;
        case 'delay':
          break;
        // T911: the AI steps write their target field of the trigger record.
        case 'ai_generate_text':
          if (action.config.target_field_id !== null) {
            write(trigger, [action.config.target_field_id]);
          }
          break;
        case 'ai_classify':
          write(trigger, [action.config.target_field_id]);
          break;
      }
    }
  };
  visit(definition.actions);
  return {
    reads,
    writes: [...writes].map(([tableId, entry]) => ({ tableId, ...entry })),
  };
}
