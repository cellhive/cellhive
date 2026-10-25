import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isAutomationValue } from '../../../lib/automation/condition-editor';
import { fieldsQuery } from '../../../lib/query/queries';

import {
  checkFilter,
  conditionCount,
  filterableFields,
  fromFilter,
  issuesByItem,
  toFilter,
  type FilterModelOptions,
  type GroupItem,
} from './filter-model';
import { FilterBuilder } from './FilterBuilder';

import type {
  AutomationConditionEditorProps,
  ConditionEditorState,
} from '../../../lib/automation/condition-editor';
import type { FieldDto } from '@cellhive/contracts';

/** The state handed to the builder: the complete conditions, valid or not, and how many wait for a value. */
function stateOf(
  root: GroupItem,
  fields: readonly FieldDto[],
  options: FilterModelOptions,
): ConditionEditorState {
  const checked = checkFilter(root, fields, options);
  return {
    filter: checked.filter as ConditionEditorState['filter'],
    valid: checked.issues.size === 0,
    incomplete: checked.incomplete.size,
  };
}

/**
 * Conditions of an automation (T521; SPEC §11.3, board "S5 · Automation
 * builder - trigger và điều kiện"): the view filter builder (T311) over the
 * fields of the table the caller reads, one level by default, with
 * `changed` / `changed_to` / `changed_from` for a `record.updated` trigger.
 * Every change reaches the builder with whether it is complete and valid;
 * issues of the last save (`422 AUTOMATION_INVALID`) mark their condition.
 */
export function AutomationConditionEditor({
  tableId,
  orgId,
  value,
  onChange,
  changeOperators = false,
  excludeFields,
  issues: serverIssues = [],
  label,
  emptyText,
  nested = false,
  ValueSource,
}: AutomationConditionEditorProps) {
  const { t } = useTranslation('toolbar');
  const fields = useQuery(fieldsQuery(tableId));
  const options = useMemo<FilterModelOptions>(() => {
    const virtual = new Set(
      (fields.data?.items ?? [])
        .filter((field) => field.compute_mode === 'virtual')
        .map((field) => field.id),
    );
    const sources = ValueSource === undefined ? {} : { isSourceValue: isAutomationValue };
    return changeOperators ? { mode: 'automation', noChangeFields: virtual, ...sources } : sources;
  }, [changeOperators, fields.data, ValueSource]);
  const filterable = useMemo(
    () =>
      filterableFields(
        (fields.data?.items ?? []).filter((field) => excludeFields?.has(field.id) !== true),
        options,
      ),
    [fields.data, excludeFields, options],
  );
  const [root, setRoot] = useState<GroupItem>(() => fromFilter(value));
  const local = useMemo(() => checkFilter(root, filterable, options), [root, filterable, options]);
  // Issues of the server, by the item at their path (the tree sent was this one).
  const merged = useMemo(() => {
    const result = new Map<string, string[]>(local.issues);
    if (serverIssues.length === 0) return result;
    const { paths } = toFilter(root, filterable, options);
    for (const [id, codes] of issuesByItem(serverIssues, paths)) {
      result.set(id, [...(result.get(id) ?? []), ...codes]);
    }
    return result;
  }, [local.issues, serverIssues, root, filterable, options]);

  if (fields.isPending) return null;
  if (filterable.length === 0 && conditionCount(root) === 0) {
    return <p className="text-body text-fg-muted">{t('filter.noFields')}</p>;
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-testid="automation-conditions"
      onKeyDown={(event) => {
        // Enter in a value box must not submit anything around it.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
        }
      }}
    >
      <FilterBuilder
        root={root}
        fields={filterable}
        issues={merged}
        incomplete={local.incomplete}
        orgId={orgId}
        emptyText={emptyText}
        rootLabel={label}
        modelOptions={options}
        maxDepth={nested ? undefined : 1}
        ValueSource={ValueSource}
        compact
        onChange={(next) => {
          setRoot(next);
          onChange(stateOf(next, filterable, options));
        }}
      />
    </div>
  );
}

export default AutomationConditionEditor;
