import { FormulaError } from './errors.js';
import { MAX_CROSS_TABLE_FILTERS, MAX_LINK_CHAIN } from './limits.js';
import { parse, type ParseOptions } from './parser.js';
import { serialize } from './serialize.js';

import type { Expr, Member, Reference } from './ast.js';
import type { ComputeMode } from './types/field-type.js';
import type { FormulaType } from './types/formula-type.js';

/**
 * Name ↔ ID resolution (SPEC §9.2). The snapshot holds what the formula's
 * author may reference: the tables of the base and their active fields the
 * author can read (SPEC §9.5) — fields and tables left out resolve like
 * missing ones.
 */
export interface SnapshotField {
  id: string;
  name: string;
  /** Target table of a link (or `parent`) field; `null`/absent for any other field. */
  linkTableId?: string | null;
  /**
   * A link to at most one record: its value is `row<target>` instead of
   * `list<row<target>>`, so `.[Field]` gives a single value (the step
   * references of automation templates, BACKLOG T505).
   */
  single?: boolean;
  /**
   * Field type (`@cellhive/field-types`) and its options, for the typecheck
   * (T452): select `multiple`/`options`, datetime `style.format`, number
   * `style`. Absent → the field's formula type is `any`.
   */
  type?: string;
  options?: Readonly<Record<string, unknown>> | null;
  /** Formula/lookup fields: the stored `result_type` and `compute_mode` of the field. */
  resultType?: FormulaType | null;
  computeMode?: ComputeMode | null;
}

export interface SnapshotTable {
  id: string;
  name: string;
  fields: readonly SnapshotField[];
  /**
   * The primary field (record title, SPEC §9.2). Records compared with a
   * text or turned into text depend on it (T456). Absent: no such dependency.
   */
  primaryFieldId?: string | null;
}

export interface SchemaSnapshot {
  /** The table the formula field belongs to. */
  tableId: string;
  tables: readonly SnapshotTable[];
}

/** Functions whose later arguments run once per element of the first (`CurrentValue`). */
const ITERATING_FUNCTIONS: ReadonlySet<string> = new Set([
  'FILTER',
  'MAP',
  'COUNTIF',
  'SUMIF',
  'SORTBY',
]);
/** Functions returning elements of their first argument: rows stay rows of the same table. */
const ROW_PRESERVING_FUNCTIONS: ReadonlySet<string> = new Set([
  'FILTER',
  'SORTBY',
  'SORT',
  'UNIQUE',
  'FIRST',
  'LAST',
  'NTH',
]);

/** Records of `tableId` an expression stands for, and how they were reached. */
interface Rows {
  tableId: string;
  /** Link hops from the row the formula runs on (or from a table/CurrentValue). */
  hops: number;
  /** Reached from a `[Table]` reference: iterating over it queries another table. */
  fromTable: boolean;
}

interface Scope {
  /** `CurrentValue` inside an iterating function: rows, a plain value, or outside any iteration. */
  current: Rows | 'value' | null;
  variables: ReadonlyMap<string, Rows | null>;
}

interface Resolved {
  node: Expr;
  rows: Rows | null;
}

class Index {
  readonly tables = new Map<string, SnapshotTable>();
  readonly tablesByName = new Map<string, SnapshotTable>();
  readonly fields = new Map<string, SnapshotField>();

  constructor(snapshot: SchemaSnapshot) {
    for (const table of snapshot.tables) {
      this.tables.set(table.id, table);
      this.tablesByName.set(table.name, table);
      for (const field of table.fields) this.fields.set(field.id, field);
    }
  }

  field(tableId: string, reference: Reference): SnapshotField | undefined {
    const table = this.tables.get(tableId);
    if (table === undefined) return undefined;
    return table.fields.find((field) =>
      reference.id !== null ? field.id === reference.id : field.name === reference.name,
    );
  }
}

function unknownField(reference: Reference): FormulaError {
  if (reference.name !== null) {
    return new FormulaError('UNKNOWN_FIELD', `Unknown field "${reference.name}".`, reference, {
      name: reference.name,
    });
  }
  return new FormulaError('UNKNOWN_FIELD', 'The referenced field no longer exists.', reference, {
    id: reference.id,
  });
}

class Resolver {
  private readonly index: Index;
  private crossTableFilters = 0;

  /** `lenient`: unknown references keep their ID with `name: null` instead of failing (rendering). */
  constructor(
    private readonly snapshot: SchemaSnapshot,
    private readonly lenient: boolean,
  ) {
    this.index = new Index(snapshot);
  }

  resolve(node: Expr): Expr {
    return this.expr(node, { current: null, variables: new Map() }).node;
  }

  private linkRows(field: SnapshotField, hops: number, fromTable: boolean): Rows | null {
    if (field.linkTableId === null || field.linkTableId === undefined) return null;
    return { tableId: field.linkTableId, hops, fromTable };
  }

  private fieldReference(reference: Reference, field: SnapshotField): Reference {
    return { ...reference, name: field.name, id: field.id, kind: 'field' };
  }

  /** A reference that could not be resolved: an error, or kept with `name: null` when lenient. */
  private broken(reference: Reference, error: FormulaError): Reference {
    if (!this.lenient || reference.id === null) throw error;
    return { ...reference, name: null };
  }

  /** `[X]` on its own: a field of the formula's table first, then a table of the base. */
  private reference(reference: Reference): Resolved {
    if (reference.kind !== 'table') {
      const field = this.index.field(this.snapshot.tableId, reference);
      if (field !== undefined) {
        return {
          node: this.fieldReference(reference, field),
          rows: this.linkRows(field, 1, false),
        };
      }
    }
    if (reference.kind !== 'field') {
      const table =
        reference.id !== null
          ? this.index.tables.get(reference.id)
          : this.index.tablesByName.get(reference.name ?? '');
      if (table !== undefined) {
        return {
          node: { ...reference, name: table.name, id: table.id, kind: 'table' },
          rows: { tableId: table.id, hops: 0, fromTable: true },
        };
      }
    }
    if (reference.kind === 'table') {
      const error = new FormulaError(
        'UNKNOWN_TABLE',
        'The referenced table no longer exists.',
        reference,
        { id: reference.id },
      );
      return { node: this.broken(reference, error), rows: null };
    }
    return { node: this.broken(reference, unknownField(reference)), rows: null };
  }

  private objectError(object: Expr, resolved: Expr): FormulaError {
    const field =
      resolved.type === 'member'
        ? resolved.property
        : resolved.type === 'reference'
          ? resolved
          : null;
    if (field?.kind === 'field') {
      return new FormulaError(
        'NOT_A_LINK',
        `The field "${field.name ?? ''}" is not a link, so it has no fields.`,
        object,
      );
    }
    if (object.type === 'current_value') {
      return new FormulaError(
        'INVALID_CURRENT_VALUE',
        'CurrentValue is a record only inside FILTER, MAP, COUNTIF, SUMIF or SORTBY over a table or a link.',
        object,
      );
    }
    return new FormulaError(
      'INVALID_MEMBER',
      'Only a table, a link field, CurrentValue or a FILTER over them has fields.',
      object,
    );
  }

  private member(node: Member, scope: Scope): Resolved {
    const object = this.expr(node.object, scope);
    const rows = object.rows;
    if (rows === null) {
      const error = this.objectError(node.object, object.node);
      if (!this.lenient) throw error;
      // Rendering: the chain is already broken; show the field by ID alone.
      const field = node.property.id === null ? undefined : this.index.fields.get(node.property.id);
      const property =
        field === undefined
          ? { ...node.property, name: null }
          : this.fieldReference(node.property, field);
      return { node: { ...node, object: object.node, property }, rows: null };
    }
    this.checkLinkChain(rows, node);
    const field = this.index.field(rows.tableId, node.property);
    if (field === undefined) {
      const property = this.broken(node.property, unknownField(node.property));
      return { node: { ...node, object: object.node, property }, rows: null };
    }
    return {
      node: { ...node, object: object.node, property: this.fieldReference(node.property, field) },
      rows: this.linkRows(field, rows.hops + 1, rows.fromTable),
    };
  }

  /** Reading fields of (or iterating over) records reached through more than `MAX_LINK_CHAIN` links. */
  private checkLinkChain(rows: Rows, node: Expr): void {
    if (rows.hops > MAX_LINK_CHAIN && !this.lenient) {
      throw new FormulaError(
        'MAX_LINK_CHAIN',
        `A chain can follow at most ${String(MAX_LINK_CHAIN)} links.`,
        node,
        { limit: MAX_LINK_CHAIN },
      );
    }
  }

  private expr(node: Expr, scope: Scope): Resolved {
    switch (node.type) {
      case 'number':
      case 'string':
      case 'boolean':
        return { node, rows: null };
      case 'current_value':
        return {
          node,
          rows:
            scope.current !== null && scope.current !== 'value'
              ? { tableId: scope.current.tableId, hops: 0, fromTable: false }
              : null,
        };
      case 'variable':
        return { node, rows: scope.variables.get(node.name.toUpperCase()) ?? null };
      case 'reference':
        return this.reference(node);
      case 'member':
        return this.member(node, scope);
      case 'unary':
        return { node: { ...node, operand: this.expr(node.operand, scope).node }, rows: null };
      case 'binary':
        return {
          node: {
            ...node,
            left: this.expr(node.left, scope).node,
            right: this.expr(node.right, scope).node,
          },
          rows: null,
        };
      case 'let': {
        const variables = new Map(scope.variables);
        const bindings = node.bindings.map((binding) => {
          const value = this.expr(binding.value, { ...scope, variables });
          variables.set(binding.name.toUpperCase(), value.rows);
          return { ...binding, value: value.node };
        });
        const body = this.expr(node.body, { ...scope, variables });
        return { node: { ...node, bindings, body: body.node }, rows: body.rows };
      }
      case 'call': {
        const [first, ...rest] = node.args;
        if (first === undefined) return { node, rows: null };
        const subject = this.expr(first, scope);
        let inner = scope;
        if (ITERATING_FUNCTIONS.has(node.name)) {
          if (subject.rows !== null) this.checkLinkChain(subject.rows, node);
          inner = { ...scope, current: subject.rows ?? 'value' };
          if (subject.rows?.fromTable === true) this.countCrossTableFilter(node);
        }
        const args = [subject.node, ...rest.map((arg) => this.expr(arg, inner).node)];
        return {
          node: { ...node, args },
          rows: ROW_PRESERVING_FUNCTIONS.has(node.name) ? subject.rows : null,
        };
      }
    }
  }

  private countCrossTableFilter(node: Expr): void {
    this.crossTableFilters += 1;
    if (this.crossTableFilters > MAX_CROSS_TABLE_FILTERS && !this.lenient) {
      throw new FormulaError(
        'MAX_CROSS_TABLE_FILTERS',
        `A formula can query other tables at most ${String(MAX_CROSS_TABLE_FILTERS)} times.`,
        node,
        { limit: MAX_CROSS_TABLE_FILTERS },
      );
    }
  }
}

/**
 * Resolves every reference against the snapshot (SPEC §9.2): `[Name]` is a
 * field of the formula's table, else a table of the base; `x.[Name]` a field
 * of the table `x` stands for (a table, the target of a link, the
 * `CurrentValue` row of FILTER/MAP/COUNTIF/SUMIF/SORTBY, or FILTER/SORTBY/…
 * of those). IDs (stored form, `#REF[…]`) are checked the same way, so a
 * restored field heals a `#REF`. Returns a new AST whose references all have
 * `id`, `kind` and the current `name`. Checks the link chain and cross-table
 * limits (SPEC §9.5). Throws `FormulaError`.
 */
export function resolveNames(ast: Expr, snapshot: SchemaSnapshot): Expr {
  return new Resolver(snapshot, false).resolve(ast);
}

/** Display text → resolved AST and the stored text to save (canonical, IDs only). */
export function toStoredFormula(
  source: string,
  snapshot: SchemaSnapshot,
): { ast: Expr; stored: string } {
  const ast = resolveNames(parse(source), snapshot);
  return { ast, stored: serialize(ast, 'stored') };
}

/**
 * Stored text → display text with the current names. An ID that is no
 * longer in the snapshot (deleted field/table, lost read access) renders as
 * `#REF[id]`, which parses again and resolves once the ID is back.
 * Throws `FormulaError` only when `stored` itself is not valid stored text.
 */
export function renderNames(
  stored: string,
  snapshot: SchemaSnapshot,
  options: Pick<ParseOptions, 'referenceIds'> = {},
): string {
  const ast = new Resolver(snapshot, true).resolve(parse(stored, { ...options, form: 'stored' }));
  return serialize(ast, 'display');
}
