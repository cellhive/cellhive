/**
 * (T1012) What the automation's condition branch builder
 * (`features/automation/builder/components/conditions`, Lucian UX/UI #132)
 * reuses of the view filter builder (T311, `features/view/toolbar`): its
 * model — a tree of `and`/`or` groups and conditions, converted to the
 * filter DSL and checked with `@cellhive/filter-dsl` like the server — and
 * its value editors by field type. A feature never imports another one
 * (FRONTEND §1.2): the route hands them over, like the webhook kit; the
 * view's `filter-model.ts` and `ValueEditor` satisfy these types.
 */

import type { FieldDto } from '@cellhive/contracts';
import type { DslOperator, FilterMode, FilterNode } from '@cellhive/filter-dsl';
import type { ComponentType } from 'react';

export interface KitCondition {
  readonly kind: 'condition';
  readonly id: string;
  readonly field: string;
  readonly operator: DslOperator;
  /** `undefined` while not chosen yet. */
  readonly value?: unknown;
}

export interface KitGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly op: 'and' | 'or';
  readonly items: readonly KitItem[];
}

/** A part the builder does not edit (a `not` node made through the API): kept, can be removed. */
export interface KitRaw {
  readonly kind: 'raw';
  readonly id: string;
  readonly node: unknown;
}

export type KitItem = KitCondition | KitGroup | KitRaw;

export interface KitModelOptions {
  readonly mode?: FilterMode;
  readonly noChangeFields?: ReadonlySet<string>;
  readonly isSourceValue?: ((value: unknown) => boolean) | undefined;
}

export type KitValueShape =
  { readonly shape: 'none' } | { readonly shape: 'one' | 'pair' | 'list'; readonly kind: string };

export interface KitBuiltFilter {
  readonly filter: FilterNode | null;
  /** DSL path of every item that made it into `filter` (`''` = the root). */
  readonly paths: ReadonlyMap<string, string>;
  readonly incomplete: ReadonlySet<string>;
}

export interface KitCheckedFilter extends KitBuiltFilter {
  readonly issues: ReadonlyMap<string, string[]>;
}

/** The pure functions of the view filter builder's model (`filter-model.ts`). */
export interface ConditionModel {
  fromFilter(filter: unknown): KitGroup;
  toFilter(root: KitGroup, fields: readonly FieldDto[], options?: KitModelOptions): KitBuiltFilter;
  checkFilter(
    root: KitGroup,
    fields: readonly FieldDto[],
    options?: KitModelOptions,
  ): KitCheckedFilter;
  issuesByItem(
    issues: readonly { readonly path: string; readonly code: string }[],
    paths: ReadonlyMap<string, string>,
  ): Map<string, string[]>;
  filterableFields(fields: readonly FieldDto[], options?: KitModelOptions): FieldDto[];
  operatorsFor(field: FieldDto, options?: KitModelOptions): readonly DslOperator[];
  valueShapeOf(field: FieldDto, operator: DslOperator): KitValueShape;
  newCondition(field: FieldDto): KitCondition;
  withOperator(condition: KitCondition, field: FieldDto, operator: DslOperator): KitCondition;
  newItemId(): string;
  updateItem(group: KitGroup, id: string, change: (item: KitItem) => KitItem | null): KitGroup;
  appendTo(root: KitGroup, groupId: string, item: KitItem): KitGroup;
  focusAfterRemoval(
    root: KitGroup,
    id: string,
  ): { readonly kind: 'item' | 'add'; readonly id: string } | null;
  conditionCount(item: KitItem): number;
  canAddCondition(root: KitGroup): boolean;
  canNestGroup(depth: number): boolean;
}

/** Props of the view's value editor (`ValueEditor.tsx`). */
export interface KitValueEditorProps {
  readonly field: FieldDto;
  readonly operator: DslOperator;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly orgId: string;
  readonly label: string;
  readonly invalid: boolean;
}

export interface ConditionKit {
  readonly model: ConditionModel;
  readonly ValueEditor: ComponentType<KitValueEditorProps>;
}
