/**
 * Dependencies of a computed field (SPEC §5.9, T452): which fields its value
 * reads and how the rows to recompute are found when one of them changes.
 *
 * - `same_row`: a field of the formula's own record (`[Field]`, a link
 *   field whose records are read) → recompute that record.
 * - `via_link`: a field of records reached through `link_path` (link field
 *   IDs, first hop on the formula's table) → recompute the records linked
 *   back through the junctions.
 * - `cross_table`: a field of another table read as a whole (`[Table]…`,
 *   FILTER/COUNTIF/SUMIF/MAP/SORTBY over a table, LOOKUP, lookup fields);
 *   `link_path` is the path from those records. `condition_refs` lists the
 *   formula-table fields (`__id` for `RECORD_ID()`) the condition matches
 *   records on (`CurrentValue.[X] = [Field]`, `CONTAIN(CurrentValue.[X], [Field])`
 *   as a top-level `&&` term): recompute the formula records whose value of
 *   one of them equals the old or new value of the changed record; an empty
 *   list means every formula record (condition of constants only, no
 *   condition, or none that can be keyed).
 */
export type DependencyKind = 'same_row' | 'via_link' | 'cross_table';

export interface FormulaDependency {
  field_id: string;
  kind: DependencyKind;
  link_path: string[];
  condition_refs: string[];
}

/** `condition_refs` value standing for the current record ID (`RECORD_ID()`). */
export const RECORD_ID_CONDITION_REF = '__id';

/** Where a set of records comes from, shared by everything read from them. */
export interface RowsOrigin {
  kind: DependencyKind;
  path: readonly string[];
  /** Cross-table only: the condition keys (see `conditionKeys`) that select these records. */
  conditionRefs: Set<string>;
  /** Records selected by FILTER/COUNTIF/… (not the whole table): later conditions add keys. */
  selected?: boolean;
}

interface Entry {
  fieldId: string;
  kind: DependencyKind;
  path: readonly string[];
  refs: Set<string>[];
}

export class DependencyCollector {
  private readonly entries = new Map<string, Entry>();
  readonly tables = new Set<string>();

  add(fieldId: string, origin: RowsOrigin | null): void {
    const kind = origin?.kind ?? 'same_row';
    const path = origin?.path ?? [];
    const key = `${fieldId}|${kind}|${path.join('.')}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { fieldId, kind, path, refs: [] };
      this.entries.set(key, entry);
    }
    if (
      origin !== null &&
      origin.kind === 'cross_table' &&
      !entry.refs.includes(origin.conditionRefs)
    ) {
      entry.refs.push(origin.conditionRefs);
    }
  }

  /** Records reached from `origin` by following `linkFieldId` (to `tableId`). */
  follow(origin: RowsOrigin | null, linkFieldId: string, tableId: string): RowsOrigin {
    this.tables.add(tableId);
    if (origin === null) {
      return { kind: 'via_link', path: [linkFieldId], conditionRefs: new Set() };
    }
    return {
      kind: origin.kind,
      path: [...origin.path, linkFieldId],
      conditionRefs: origin.conditionRefs,
    };
  }

  /** Every record of `tableId` (`[Table]`, LOOKUP). */
  table(tableId: string): RowsOrigin {
    this.tables.add(tableId);
    return { kind: 'cross_table', path: [], conditionRefs: new Set() };
  }

  result(): FormulaDependency[] {
    return [...this.entries.values()].map((entry) => {
      // One read without a condition (`[Table].[Field]`) needs the whole table.
      const refs = new Set<string>();
      if (entry.refs.every((set) => set.size > 0)) {
        for (const set of entry.refs) for (const ref of set) refs.add(ref);
      }
      return {
        field_id: entry.fieldId,
        kind: entry.kind,
        link_path: [...entry.path],
        condition_refs: entry.kind === 'cross_table' ? [...refs].sort() : [],
      };
    });
  }
}
