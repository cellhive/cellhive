import {
  isId,
  isTemplateReferenceId,
  newId,
  parseValuePath,
  type AutomationDefinition,
  type BasePackageDetachedKind,
  type Id,
  type WidgetType,
} from '@cellhive/contracts';
import { splitTemplate, tryParse, type Expr, type Reference } from '@cellhive/formula-engine';

import { emailAssetReferencesOf, replaceEmailAssetIds } from '../automation/duplicate/duplicate.js';
import { remapWidgetIds } from '../dashboards/widget-config.js';

import { packagePath, PackageProblems } from './errors.js';
import {
  isPackageId,
  packageIdPrefixOf,
  type PackageDetached,
  type PackageIdPrefix,
} from './manifest.js';

import type { PackageUserMode } from './users.js';

/**
 * Ids and references of a `.chbase` package (ADR-24 §2.2–§2.3 and its
 * 2026-11 amendment). An import gives every object a new id
 * ({@link PackageIdMap}) and rewrites every reference, shape by shape —
 * never by searching ids in JSON text:
 *
 * - formulas and templates (AI prompts, automation templates) through the
 *   formula AST: each `[fld_…]`/`[tbl_…]` reference the parser finds is
 *   replaced at its exact place in the text, nothing else changes;
 * - field options (select options and default, user default, date
 *   reminder, link, lookup, formula, `options.ai`), Filter DSL trees (field,
 *   `field_ref`, and the option/user/record operands of each condition by
 *   the kind of its field), view configs, dashboards and widgets (widget
 *   ids through `remapWidgetIds`), role configs, automation definitions
 *   (body images through `replaceEmailAssetIds`), record cells, junction
 *   rows and file metadata.
 *
 * The same walk serves both directions:
 * - `export`: ids are kept, user ids become emails, a reference to an
 *   object the package does not hold (in the trash, deleted) is left out
 *   where it can be (a filter condition, a list entry, a map key) and
 *   otherwise kept and listed in `missingIds()` (→ `schema/base.json`
 *   `missing_ids`); secrets, sending identities, groups and incoming
 *   webhooks of automations are replaced by `null` and listed (`detached`);
 * - `import`: every id goes through the map — an id the package does not
 *   define is `DANGLING_REFERENCE` with the place it is at — emails become
 *   members of the target organization, and detached slots stay `null`
 *   whatever the package holds there.
 *
 * Shapes that are not what they should be are passed through unchanged:
 * the importer then checks every rewritten object with its own schema
 * (and refuses it), so nothing unchecked reaches the database.
 */

// --- Places -------------------------------------------------------------------------

/** A place in the package (entry, NDJSON line, JSON pointer), built only when a problem needs it. */
export class PackageLocation {
  private constructor(
    private readonly parent: PackageLocation | null,
    private readonly key: string | number | null,
    private readonly entry: string,
  ) {}

  /** The root of an entry, or of line `line` of an NDJSON entry. */
  static of(entry: string, line?: number): PackageLocation {
    return new PackageLocation(null, null, line === undefined ? entry : `${entry}:${String(line)}`);
  }

  at(...keys: readonly (string | number)[]): PackageLocation {
    return keys.reduce<PackageLocation>(
      (parent, key) => new PackageLocation(parent, key, this.entry),
      this,
    );
  }

  private segments(): (string | number)[] {
    const above = this.parent === null ? [] : this.parent.segments();
    return this.key === null ? above : [...above, this.key];
  }

  /** `entry#/json/pointer`. */
  toString(): string {
    return packagePath(this.entry, this.segments());
  }

  /** The dotted path below `ancestor` (`actions[0].config.secret_id`), as definitions name places. */
  dottedFrom(ancestor: PackageLocation): string {
    const own = this.segments();
    const start = ancestor.segments().length;
    let text = '';
    for (const part of own.slice(start)) {
      text += typeof part === 'number' ? `[${String(part)}]` : text === '' ? part : `.${part}`;
    }
    return text;
  }
}

// --- Resolvers ----------------------------------------------------------------------

/** How ids of one direction change. */
export interface PackageIdResolver {
  /**
   * The id `id` becomes, or `null` when there is no object behind it.
   * Options are resolved per select field: `owner` is the field whose
   * options hold `id` (option ids may repeat across fields).
   */
  resolve(id: string, owner?: string): string | null;
}

/** How user references of one direction change. */
export interface PackageUserResolver {
  /** What a user reference becomes at a place of `mode`; `null` = leave it out. */
  resolve(value: string, mode: PackageUserMode): string | null;
}

/** Key of an option in a {@link PackageIdMap}: options are per select field. */
function optionKey(owner: string, id: string): string {
  return `${owner}/${id}`;
}

/**
 * Import side: every id the package defines → a new id of the same prefix
 * (`newId`), options per select field. Records may be resolved elsewhere
 * (`records`: a large base keeps them out of memory).
 */
export class PackageIdMap implements PackageIdResolver {
  private readonly ids = new Map<string, string>();

  constructor(private readonly records?: PackageIdResolver) {}

  /**
   * Gives `id` a new id; `false` when it already has one (two objects of
   * the package with one id). `owner` for options only.
   */
  assign(id: string, owner?: string): boolean {
    const prefix = packageIdPrefixOf(id);
    if (prefix === null) return false;
    const key = prefix === 'opt' && owner !== undefined ? optionKey(owner, id) : id;
    if (this.ids.has(key)) return false;
    this.ids.set(key, newId(prefix));
    return true;
  }

  resolve(id: string, owner?: string): string | null {
    if (this.records !== undefined && isId('rec', id)) return this.records.resolve(id);
    if (isId('opt', id)) {
      return owner === undefined ? null : (this.ids.get(optionKey(owner, id)) ?? null);
    }
    return this.ids.get(id) ?? null;
  }

  get size(): number {
    return this.ids.size;
  }
}

/** What a package defines, for {@link assignPackageIds}. */
export interface PackageIdSources {
  readonly tables?: readonly unknown[];
  readonly views?: readonly unknown[];
  readonly dashboards?: readonly unknown[];
  readonly automations?: readonly unknown[];
  readonly roles?: readonly unknown[];
  readonly files?: readonly unknown[];
  /** `schema/base.json` `missing_ids`: new ids that name nothing. */
  readonly missingIds?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Assigns a new id to every object the schema of the package defines
 * (records aside: the importer assigns them while reading `data/*`), and
 * to each missing id. Two definitions of one id are `DUPLICATE_ID`.
 */
export function assignPackageIds(
  map: PackageIdMap,
  sources: PackageIdSources,
  problems: PackageProblems,
): void {
  const define = (id: unknown, location: PackageLocation, owner?: string) => {
    if (typeof id !== 'string' || !isPackageId(id)) return;
    if (!map.assign(id, owner)) {
      problems.add('DUPLICATE_ID', location.toString(), 'Two objects of the package have one id.', {
        id,
        reason: 'package',
      });
    }
  };
  const tables = PackageLocation.of('schema/tables.json').at('tables');
  for (const [index, table] of arrayOf(sources.tables).entries()) {
    if (!isRecord(table)) continue;
    define(table['id'], tables.at(index, 'id'));
    for (const [position, field] of arrayOf(table['fields']).entries()) {
      if (!isRecord(field)) continue;
      const at = tables.at(index, 'fields', position);
      define(field['id'], at.at('id'));
      const options = field['options'];
      if (field['type'] === 'select' && isRecord(options) && typeof field['id'] === 'string') {
        for (const [item, option] of arrayOf(options['options']).entries()) {
          if (isRecord(option)) {
            define(option['id'], at.at('options', 'options', item, 'id'), field['id']);
          }
        }
      }
    }
  }
  const views = PackageLocation.of('schema/views.json').at('views');
  for (const [index, view] of arrayOf(sources.views).entries()) {
    if (!isRecord(view)) continue;
    define(view['id'], views.at(index, 'id'));
    const config = view['config'];
    if (isRecord(config)) {
      for (const [item, rule] of arrayOf(config['color_rules']).entries()) {
        if (isRecord(rule))
          define(rule['id'], views.at(index, 'config', 'color_rules', item, 'id'));
      }
    }
  }
  const dashboards = PackageLocation.of('schema/dashboards.json').at('dashboards');
  for (const [index, dashboard] of arrayOf(sources.dashboards).entries()) {
    if (!isRecord(dashboard)) continue;
    define(dashboard['id'], dashboards.at(index, 'id'));
    for (const [item, widget] of arrayOf(dashboard['widgets']).entries()) {
      if (isRecord(widget)) define(widget['id'], dashboards.at(index, 'widgets', item, 'id'));
    }
  }
  const automations = PackageLocation.of('schema/automations.json').at('automations');
  for (const [index, automation] of arrayOf(sources.automations).entries()) {
    if (isRecord(automation)) define(automation['id'], automations.at(index, 'id'));
  }
  const roles = PackageLocation.of('schema/roles.json').at('roles');
  for (const [index, role] of arrayOf(sources.roles).entries()) {
    if (isRecord(role)) define(role['id'], roles.at(index, 'id'));
  }
  const files = PackageLocation.of('files/attachments.json').at('files');
  for (const [index, file] of arrayOf(sources.files).entries()) {
    if (isRecord(file)) define(file['id'], files.at(index, 'id'));
  }
  const missing = PackageLocation.of('schema/base.json').at('missing_ids');
  for (const [index, id] of (sources.missingIds ?? []).entries()) {
    // A missing option keeps no owner: it can only stand where its field is unknown too.
    define(id, missing.at(index));
  }
}

// --- Schema catalog (kinds of values) ------------------------------------------------

/** A field as the catalog needs it (ids of the input side of the walk). */
export interface PackageCatalogField {
  readonly id: string;
  readonly type: string;
  readonly options?: unknown;
  /** `formula`/`lookup`: `meta.fields.result_type` (`FormulaType` JSON). */
  readonly result_type?: unknown;
}

export interface PackageCatalogInput {
  readonly tables: readonly {
    readonly id: string;
    readonly fields: readonly PackageCatalogField[];
  }[];
}

/** What the values of a field are made of, where ids hide in them. */
export type PackageValueKind = 'option' | 'user' | 'record' | 'attachment' | 'plain';

const USER_TYPES = new Set(['user', 'created_by', 'updated_by']);
const LIST_LOOKUPS = new Set(['raw_value', 'unique']);

/**
 * The fields of the base on the input side of the walk (package ids on
 * import, source ids on export): which table a field is in and what its
 * values are made of — for the operands of filter conditions, whose kind
 * is the kind of their field.
 */
export class PackageSchemaCatalog {
  private readonly fields = new Map<string, PackageCatalogField & { readonly tableId: string }>();

  constructor(input: PackageCatalogInput) {
    for (const table of input.tables) {
      for (const field of table.fields) this.fields.set(field.id, { ...field, tableId: table.id });
    }
  }

  field(id: string): (PackageCatalogField & { readonly tableId: string }) | undefined {
    return this.fields.get(id);
  }

  /**
   * The select field whose options the values of `id` are: itself, or the
   * select a lookup (of a lookup…) shows.
   */
  optionOwner(id: string): string | null {
    let current = this.fields.get(id);
    for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
      if (current.type === 'select') return current.id;
      if (current.type !== 'lookup' || !isRecord(current.options)) return null;
      const aggregate = current.options['aggregate'] ?? 'raw_value';
      if (typeof aggregate !== 'string' || !LIST_LOOKUPS.has(aggregate)) return null;
      const next = current.options['select'];
      current = typeof next === 'string' ? this.fields.get(next) : undefined;
    }
    return null;
  }

  valueKind(id: string): PackageValueKind {
    let current = this.fields.get(id);
    for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
      switch (current.type) {
        case 'select':
          return 'option';
        case 'link':
        case 'parent':
          return 'record';
        case 'attachment':
          return 'attachment';
        case 'formula':
          return formulaValueKind(current.result_type);
        case 'lookup': {
          if (!isRecord(current.options)) return 'plain';
          const aggregate = current.options['aggregate'] ?? 'raw_value';
          if (typeof aggregate !== 'string' || !LIST_LOOKUPS.has(aggregate)) return 'plain';
          const next = current.options['select'];
          current = typeof next === 'string' ? this.fields.get(next) : undefined;
          continue;
        }
        default:
          return USER_TYPES.has(current.type) ? 'user' : 'plain';
      }
    }
    return 'plain';
  }
}

function formulaValueKind(resultType: unknown): PackageValueKind {
  let type = resultType;
  for (let depth = 0; isRecord(type) && depth < 8; depth += 1) {
    switch (type['kind']) {
      case 'user':
        return 'user';
      case 'row':
        return 'record';
      case 'attachment':
        return 'attachment';
      case 'list':
        type = type['element'];
        continue;
      default:
        return 'plain';
    }
  }
  return 'plain';
}

/** Field types whose value is stored in the record (and so in `data/<tbl>.ndjson`). */
export const PACKAGE_VALUE_FIELD_TYPES = [
  'text',
  'number',
  'checkbox',
  'datetime',
  'select',
  'user',
  'attachment',
  'auto_number',
] as const;

export function isPackageValueFieldType(type: string): boolean {
  return (PACKAGE_VALUE_FIELD_TYPES as readonly string[]).includes(type);
}

// --- Formula AST --------------------------------------------------------------------

/** Every reference of a formula AST, walked without recursion (long `a + b + …` chains). */
export function formulaReferences(ast: Expr): Reference[] {
  const out: Reference[] = [];
  const stack: Expr[] = [ast];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    switch (node.type) {
      case 'reference':
        out.push(node);
        break;
      case 'member':
        out.push(node.property);
        stack.push(node.object);
        break;
      case 'call':
        stack.push(...node.args);
        break;
      case 'let':
        for (const binding of node.bindings) stack.push(binding.value);
        stack.push(node.body);
        break;
      case 'unary':
        stack.push(node.operand);
        break;
      case 'binary':
        stack.push(node.left, node.right);
        break;
      default:
        break;
    }
  }
  return out;
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function applyEdits(source: string, edits: TextEdit[]): string {
  if (edits.length === 0) return source;
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const edit of edits) {
    out += source.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + source.slice(at);
}

// --- The walk -----------------------------------------------------------------------

const DROP: unique symbol = Symbol('drop');

export type PackageDirection = 'export' | 'import';

/** Where a filter is (see {@link PackageRewriter.filter}). */
export type PackageFilterMode = 'view' | 'rule' | 'automation';

export interface PackageRewriterOptions {
  readonly direction: PackageDirection;
  readonly ids: PackageIdResolver;
  readonly users: PackageUserResolver;
  readonly catalog: PackageSchemaCatalog;
  /** Export: the name of a secret, sending identity, group or incoming webhook. */
  readonly detachedName?: (kind: BasePackageDetachedKind, id: string) => string;
  /** Collects the problems of an import (`DANGLING_REFERENCE`, `INVALID_DEFINITION`…). */
  readonly problems?: PackageProblems;
}

/** A rewritten automation and the slots it no longer fills. */
export interface RewrittenAutomation {
  readonly automation: Record<string, unknown>;
  readonly detached: PackageDetached[];
}

export class PackageRewriter {
  readonly problems: PackageProblems;
  private readonly missing = new Set<string>();
  private readonly direction: PackageDirection;

  constructor(private readonly options: PackageRewriterOptions) {
    this.problems = options.problems ?? new PackageProblems();
    this.direction = options.direction;
  }

  /** Export: ids kept although the package does not hold them (`schema/base.json` `missing_ids`). */
  missingIds(): string[] {
    return [...this.missing].sort();
  }

  // --- Ids ---------------------------------------------------------------------------

  /**
   * The id at `location` (expected prefix `prefix`) on the other side; a
   * value that is not such an id is kept (the schema check refuses it).
   * Unresolved: export → `DROP` where `droppable`, else kept and listed
   * missing; import → `DANGLING_REFERENCE`.
   */
  private id(
    value: unknown,
    prefix: PackageIdPrefix,
    location: PackageLocation,
    droppable: boolean,
    owner?: string,
  ): unknown {
    if (!isId(prefix, value)) return value;
    const mapped = this.options.ids.resolve(value, owner);
    if (mapped !== null) return mapped;
    if (this.direction === 'export') {
      if (droppable) return DROP;
      this.missing.add(value);
      return value;
    }
    this.problems.add(
      'DANGLING_REFERENCE',
      location.toString(),
      'The package names an id it does not define.',
      { id: value },
    );
    return value;
  }

  /** An id that may not be left out. */
  private kept(
    value: unknown,
    prefix: PackageIdPrefix,
    location: PackageLocation,
    owner?: string,
  ): unknown {
    return this.id(value, prefix, location, false, owner);
  }

  /** An id that may be left out (`null` in its slot). */
  private orNull(value: unknown, prefix: PackageIdPrefix, location: PackageLocation): unknown {
    const mapped = this.id(value, prefix, location, true);
    return mapped === DROP ? null : mapped;
  }

  private idList(value: unknown, prefix: PackageIdPrefix, location: PackageLocation): unknown {
    if (!Array.isArray(value)) return value;
    return value
      .map((item: unknown, index) => this.id(item, prefix, location.at(index), true))
      .filter((item) => item !== DROP);
  }

  /** An object keyed by ids; entries whose key is left out disappear. */
  private idKeys(
    value: unknown,
    prefix: PackageIdPrefix,
    location: PackageLocation,
    item: (inner: unknown, inputKey: string, at: PackageLocation) => unknown = (inner) => inner,
  ): unknown {
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const at = location.at(key);
      const mapped = this.id(key, prefix, at, true);
      if (mapped === DROP) continue;
      out[typeof mapped === 'string' ? mapped : key] = item(inner, key, at);
    }
    return out;
  }

  // --- Users -------------------------------------------------------------------------

  /** A user reference: an id on export (→ email), an email on import (→ member). */
  private user(value: unknown, mode: PackageUserMode, location: PackageLocation): unknown {
    if (typeof value !== 'string') return value;
    if (this.direction === 'import' && (isId('usr', value) || !value.includes('@'))) {
      this.problems.add(
        'INVALID_ENTRY',
        location.toString(),
        'A package names users by email, never by user id.',
      );
      return value;
    }
    if (this.direction === 'export' && !isId('usr', value)) return value;
    return this.options.users.resolve(value, mode) ?? DROP;
  }

  private userList(value: unknown, mode: PackageUserMode, location: PackageLocation): unknown {
    if (!Array.isArray(value)) return value;
    return value
      .map((item: unknown, index) => this.user(item, mode, location.at(index)))
      .filter((item) => item !== DROP);
  }

  /** `created_by`/`updated_by`-like single user, `null` when left out. */
  userOrNull(value: string | null | undefined, location: PackageLocation): string | null {
    if (value === null || value === undefined) return null;
    const mapped = this.user(value, 'value', location);
    return typeof mapped === 'string' ? mapped : null;
  }

  // --- Formulas and templates ----------------------------------------------------------

  private referenceEdit(
    reference: Reference,
    source: string,
    offset: number,
    location: PackageLocation,
    edits: TextEdit[],
  ): void {
    const id = reference.id;
    if (id === null) return;
    const prefix = isId('tbl', id) ? 'tbl' : isId('fld', id) ? 'fld' : null;
    // `[act_…]`, `[@…]`: references of the definition itself, kept as they are.
    if (prefix === null) return;
    const start = offset + reference.start;
    const end = start + reference.length;
    if (source.slice(start, end) !== `[${id}]`) {
      this.problems.add('INVALID_DEFINITION', location.toString(), 'A reference cannot be read.');
      return;
    }
    const mapped = this.kept(id, prefix, location);
    if (typeof mapped === 'string' && mapped !== id)
      edits.push({ start, end, text: `[${mapped}]` });
  }

  /** A stored formula (`[fld_…]`/`[tbl_…]`). */
  formula(expression: unknown, location: PackageLocation): unknown {
    if (typeof expression !== 'string') return expression;
    const parsed = tryParse(expression, { form: 'stored' });
    if (!parsed.ok) {
      this.problems.add('INVALID_DEFINITION', location.toString(), 'A formula cannot be read.');
      return expression;
    }
    const edits: TextEdit[] = [];
    for (const reference of formulaReferences(parsed.ast)) {
      this.referenceEdit(reference, expression, 0, location, edits);
    }
    return applyEdits(expression, edits);
  }

  /** A stored template (`{{ [fld_…] }}`: AI prompts, automation texts). */
  template(source: unknown, location: PackageLocation): unknown {
    if (typeof source !== 'string') return source;
    const split = splitTemplate(source);
    if (split.issues.length > 0) {
      this.problems.add('INVALID_DEFINITION', location.toString(), 'A template cannot be read.');
      return source;
    }
    const edits: TextEdit[] = [];
    for (const part of split.parts) {
      if (part.kind !== 'expression') continue;
      const parsed = tryParse(part.expression, {
        form: 'stored',
        referenceIds: isTemplateReferenceId,
      });
      if (!parsed.ok) {
        this.problems.add('INVALID_DEFINITION', location.toString(), 'A template cannot be read.');
        continue;
      }
      for (const reference of formulaReferences(parsed.ast)) {
        this.referenceEdit(reference, source, part.expressionStart, location, edits);
      }
    }
    return applyEdits(source, edits);
  }

  // --- Field options and cells ---------------------------------------------------------

  /** Options of a field (`type`) of the table `tableId`. */
  fieldOptions(
    field: { readonly id: string; readonly type: string; readonly options: unknown },
    location: PackageLocation,
  ): unknown {
    const options = field.options;
    if (!isRecord(options)) return options;
    const out: Record<string, unknown> = { ...options };
    if (isRecord(out['ai'])) out['ai'] = this.aiOptions(out['ai'], location.at('ai'));
    switch (field.type) {
      case 'select': {
        if (Array.isArray(out['options'])) {
          out['options'] = out['options'].map((option: unknown, index) =>
            isRecord(option)
              ? {
                  ...option,
                  id: this.kept(option['id'], 'opt', location.at('options', index, 'id'), field.id),
                }
              : option,
          );
        }
        if (out['default_value'] !== undefined && out['default_value'] !== null) {
          out['default_value'] = this.optionValue(
            out['default_value'],
            field.id,
            location.at('default_value'),
            true,
          );
        }
        break;
      }
      case 'user': {
        if (Array.isArray(out['default_value'])) {
          const at = location.at('default_value');
          out['default_value'] = out['default_value']
            .map((entry: unknown, index) => {
              if (!isRecord(entry) || !('id' in entry)) return entry;
              const mapped = this.user(entry['id'], 'value', at.at(index, 'id'));
              return mapped === DROP ? DROP : { ...entry, id: mapped };
            })
            .filter((entry) => entry !== DROP);
        }
        break;
      }
      case 'datetime': {
        if (isRecord(out['reminder'])) {
          out['reminder'] = this.reminder(out['reminder'], location.at('reminder'));
        }
        break;
      }
      case 'link': {
        out['link_table'] = this.kept(out['link_table'], 'tbl', location.at('link_table'));
        if (out['symmetric_field_id'] !== null && out['symmetric_field_id'] !== undefined) {
          out['symmetric_field_id'] = this.kept(
            out['symmetric_field_id'],
            'fld',
            location.at('symmetric_field_id'),
          );
        }
        if (isRecord(out['record_filter'])) {
          out['record_filter'] = this.filter(
            out['record_filter'],
            location.at('record_filter'),
            'rule',
          );
        }
        break;
      }
      case 'lookup': {
        out['from'] = this.kept(out['from'], 'tbl', location.at('from'));
        out['select'] = this.kept(out['select'], 'fld', location.at('select'));
        if (isRecord(out['where'])) {
          out['where'] = this.filter(out['where'], location.at('where'), 'rule') ?? out['where'];
        }
        break;
      }
      case 'formula':
        out['expression'] = this.formula(out['expression'], location.at('expression'));
        break;
      default:
        break;
    }
    return out;
  }

  private aiOptions(ai: Record<string, unknown>, location: PackageLocation): unknown {
    return { ...ai, prompt: this.template(ai['prompt'], location.at('prompt')) };
  }

  private reminder(reminder: Record<string, unknown>, location: PackageLocation): unknown {
    const out: Record<string, unknown> = { ...reminder };
    if (reminder['recipients'] === 'field_user') {
      out['user_field_id'] = this.kept(
        reminder['user_field_id'],
        'fld',
        location.at('user_field_id'),
      );
      return out;
    }
    if (Array.isArray(reminder['user_ids'])) {
      const users = this.userList(reminder['user_ids'], 'value', location.at('user_ids'));
      // Nobody left to remind: the reminder is off.
      if (Array.isArray(users) && users.length === 0) return null;
      out['user_ids'] = users;
    }
    return out;
  }

  /** A select value: an option id or a list of them (other strings — names — are kept). */
  private optionValue(
    value: unknown,
    owner: string | null,
    location: PackageLocation,
    droppable: boolean,
  ): unknown {
    const one = (item: unknown, at: PackageLocation): unknown =>
      owner === null ? item : this.id(item, 'opt', at, droppable, owner);
    if (Array.isArray(value)) {
      return value
        .map((item: unknown, index) => one(item, location.at(index)))
        .filter((item) => item !== DROP);
    }
    const mapped = one(value, location);
    return mapped === DROP ? null : mapped;
  }

  /**
   * A stored cell value of `fieldId` (input side): option ids, users,
   * attachments (`{ id, name, size, mime }`) and record ids are rewritten.
   */
  cellValue(fieldId: string, value: unknown, location: PackageLocation): unknown {
    const field = this.options.catalog.field(fieldId);
    if (field === undefined || value === null || value === undefined) return value;
    switch (field.type) {
      case 'select':
        return this.optionValue(value, field.id, location, true);
      case 'user':
        return this.userList(value, 'value', location);
      case 'attachment':
        if (!Array.isArray(value)) return value;
        return value
          .map((item: unknown, index) => {
            if (!isRecord(item)) return item;
            const id = this.id(item['id'], 'att', location.at(index, 'id'), true);
            return id === DROP ? DROP : { ...item, id };
          })
          .filter((item) => item !== DROP);
      default:
        return value;
    }
  }

  /** A value an automation writes into `fieldId` (`{ literal }`), by the kind of the field. */
  private literalFor(fieldId: string | null, value: unknown, location: PackageLocation): unknown {
    if (fieldId === null) return value;
    const field = this.options.catalog.field(fieldId);
    if (field === undefined) return value;
    switch (this.options.catalog.valueKind(fieldId)) {
      case 'option':
        return this.optionValue(value, this.options.catalog.optionOwner(fieldId), location, false);
      case 'user':
        return Array.isArray(value)
          ? this.userList(value, 'value', location)
          : (() => {
              const mapped = this.user(value, 'value', location);
              return mapped === DROP ? null : mapped;
            })();
      case 'record':
        return Array.isArray(value)
          ? value.map((item: unknown, index) => this.kept(item, 'rec', location.at(index)))
          : this.kept(value, 'rec', location);
      default:
        return value;
    }
  }

  // --- Filter DSL ----------------------------------------------------------------------

  /**
   * A Filter DSL tree (SPEC §6.1), in one of three kinds of place:
   * - `view` — view, color rule and widget filters: on export a condition
   *   on a field the package does not hold is left out, as querying
   *   ignores it, and a group left empty disappears (`null`);
   * - `rule` — role record rules, lookup `where`, link `record_filter`:
   *   every condition is kept (an id the package does not hold is listed
   *   missing), so a rule never selects more records than it did;
   * - `automation` — like `rule`, and operands may be values of SPEC §11.4
   *   (`{ field }`, `{ step }`, `{ template }`, `{ literal }`).
   */
  filter(
    node: unknown,
    location: PackageLocation,
    mode: PackageFilterMode = 'view',
  ): Record<string, unknown> | null {
    const result = this.filterNode(node, location, mode);
    if (result === DROP) return null;
    return isRecord(result) ? result : null;
  }

  private filterNode(node: unknown, location: PackageLocation, mode: PackageFilterMode): unknown {
    if (!isRecord(node)) return node;
    if (node['op'] === 'and' || node['op'] === 'or') {
      if (!Array.isArray(node['items'])) return node;
      const items = node['items']
        .map((item: unknown, index) => this.filterNode(item, location.at('items', index), mode))
        .filter((item) => item !== DROP);
      if (items.length === 0 && node['items'].length > 0) return DROP;
      return { ...node, items };
    }
    if (node['op'] === 'not') {
      const item = this.filterNode(node['item'], location.at('item'), mode);
      return item === DROP ? DROP : { ...node, item };
    }
    if (typeof node['field'] !== 'string') return node;
    const fieldId = node['field'];
    const field = this.id(fieldId, 'fld', location.at('field'), mode === 'view');
    if (field === DROP) return DROP;
    const out: Record<string, unknown> = { ...node, field };
    if ('value' in node) {
      out['value'] = this.operands(
        node['value'],
        fieldId,
        location.at('value'),
        mode === 'automation',
      );
    }
    return out;
  }

  private operands(
    value: unknown,
    fieldId: string,
    location: PackageLocation,
    automation: boolean,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((item: unknown, index) =>
        this.operand(item, fieldId, location.at(index), automation),
      );
    }
    return this.operand(value, fieldId, location, automation);
  }

  private operand(
    value: unknown,
    fieldId: string,
    location: PackageLocation,
    automation: boolean,
  ): unknown {
    const catalog = this.options.catalog;
    if (isRecord(value)) {
      if ('field_ref' in value) {
        return {
          ...value,
          field_ref: this.kept(value['field_ref'], 'fld', location.at('field_ref')),
        };
      }
      if ('$var' in value || '$date' in value) return value;
      if ('id' in value && Object.keys(value).length === 1) {
        return { id: this.operand(value['id'], fieldId, location.at('id'), automation) };
      }
      if (automation) {
        if ('literal' in value) {
          return {
            ...value,
            literal: this.operands(value['literal'], fieldId, location.at('literal'), false),
          };
        }
        return this.automationValue(value, location, null);
      }
      return value;
    }
    if (typeof value !== 'string') return value;
    switch (catalog.valueKind(fieldId)) {
      case 'option':
        return this.optionValue(value, catalog.optionOwner(fieldId), location, false);
      case 'user': {
        const mapped = this.user(value, 'reference', location);
        return mapped === DROP ? value : mapped;
      }
      case 'record':
        return this.kept(value, 'rec', location);
      default:
        return value;
    }
  }

  // --- Views ---------------------------------------------------------------------------

  /** A shared view of `schema/views.json`. */
  view(view: unknown, location: PackageLocation): unknown {
    if (!isRecord(view)) return view;
    return {
      ...view,
      id: this.kept(view['id'], 'viw', location.at('id')),
      table_id: this.kept(view['table_id'], 'tbl', location.at('table_id')),
      config: this.viewConfig(view['config'], location.at('config')),
    };
  }

  /** A `StoredViewConfig`. */
  viewConfig(config: unknown, location: PackageLocation): unknown {
    if (!isRecord(config)) return config;
    const out: Record<string, unknown> = { ...config };
    if ('filter' in config) out['filter'] = this.filter(config['filter'], location.at('filter'));
    for (const key of ['sort', 'group'] as const) {
      if (Array.isArray(config[key])) out[key] = this.sorts(config[key], location.at(key));
    }
    for (const key of ['hidden_fields', 'field_order'] as const) {
      if (key in config) out[key] = this.idList(config[key], 'fld', location.at(key));
    }
    if ('column_widths' in config) {
      out['column_widths'] = this.idKeys(
        config['column_widths'],
        'fld',
        location.at('column_widths'),
      );
    }
    if ('summaries' in config) {
      out['summaries'] = this.idKeys(config['summaries'], 'fld', location.at('summaries'));
    }
    if (isRecord(config['record_detail'])) {
      const detail = config['record_detail'];
      const at = location.at('record_detail', 'link_columns');
      out['record_detail'] = {
        ...detail,
        link_columns: this.idKeys(detail['link_columns'], 'fld', at, (columns, _key, inner) =>
          this.idList(columns, 'fld', inner),
        ),
      };
    }
    if (Array.isArray(config['color_rules'])) {
      out['color_rules'] = config['color_rules'].map((rule: unknown, index) =>
        this.colorRule(rule, location.at('color_rules', index)),
      );
    }
    if (isRecord(config['kanban'])) {
      const kanban = config['kanban'];
      const at = location.at('kanban');
      out['kanban'] = {
        ...kanban,
        group_field: this.orNull(kanban['group_field'], 'fld', at.at('group_field')),
        card_fields: this.idList(kanban['card_fields'], 'fld', at.at('card_fields')),
        cover_field: this.orNull(kanban['cover_field'], 'fld', at.at('cover_field')),
      };
    }
    if (isRecord(config['form'])) {
      const form = config['form'];
      const at = location.at('form');
      out['form'] = {
        ...form,
        cover_attachment_id: this.orNull(
          form['cover_attachment_id'],
          'att',
          at.at('cover_attachment_id'),
        ),
        fields: Array.isArray(form['fields'])
          ? form['fields']
              .map((item: unknown, index) => {
                if (!isRecord(item)) return item;
                const id = this.id(item['field'], 'fld', at.at('fields', index, 'field'), true);
                return id === DROP ? DROP : { ...item, field: id };
              })
              .filter((item) => item !== DROP)
          : form['fields'],
      };
    }
    return out;
  }

  private sorts(items: readonly unknown[], location: PackageLocation): unknown[] {
    return items
      .map((item: unknown, index) => {
        if (!isRecord(item)) return item;
        const id = this.id(item['field'], 'fld', location.at(index, 'field'), true);
        return id === DROP ? DROP : { ...item, field: id };
      })
      .filter((item) => item !== DROP);
  }

  private colorRule(rule: unknown, location: PackageLocation): unknown {
    if (!isRecord(rule)) return rule;
    const out: Record<string, unknown> = {
      ...rule,
      id: this.kept(rule['id'], 'clr', location.at('id')),
    };
    if ('filter' in rule) out['filter'] = this.filter(rule['filter'], location.at('filter'));
    if (rule['field_id'] !== null && rule['field_id'] !== undefined) {
      out['field_id'] = this.kept(rule['field_id'], 'fld', location.at('field_id'));
    }
    return out;
  }

  // --- Dashboards ----------------------------------------------------------------------

  /** A dashboard of `schema/dashboards.json`, with its widgets. */
  dashboard(dashboard: unknown, location: PackageLocation): unknown {
    if (!isRecord(dashboard)) return dashboard;
    const widgets = arrayOf(dashboard['widgets']);
    // Widgets name widgets of their own dashboard only.
    const widgetIds = new Map<string, string>();
    for (const widget of widgets) {
      if (!isRecord(widget) || !isId('wgt', widget['id'])) continue;
      const mapped = this.options.ids.resolve(widget['id']);
      if (mapped !== null) widgetIds.set(widget['id'], mapped);
    }
    return {
      ...dashboard,
      id: this.kept(dashboard['id'], 'dsh', location.at('id')),
      global_filters: Array.isArray(dashboard['global_filters'])
        ? dashboard['global_filters'].map((filter: unknown, index) =>
            this.globalFilter(filter, location.at('global_filters', index)),
          )
        : dashboard['global_filters'],
      widgets: Array.isArray(dashboard['widgets'])
        ? dashboard['widgets'].map((widget: unknown, index) =>
            this.widget(widget, widgetIds, location.at('widgets', index)),
          )
        : dashboard['widgets'],
    };
  }

  private globalFilter(filter: unknown, location: PackageLocation): unknown {
    if (!isRecord(filter) || !Array.isArray(filter['targets'])) return filter;
    return {
      ...filter,
      targets: filter['targets'].map((target: unknown, index) =>
        isRecord(target)
          ? {
              ...target,
              table_id: this.kept(
                target['table_id'],
                'tbl',
                location.at('targets', index, 'table_id'),
              ),
              field: this.kept(target['field'], 'fld', location.at('targets', index, 'field')),
            }
          : target,
      ),
    };
  }

  private widget(
    widget: unknown,
    widgetIds: ReadonlyMap<string, string>,
    location: PackageLocation,
  ): unknown {
    if (!isRecord(widget)) return widget;
    const type = widget['type'];
    return {
      ...widget,
      id: this.kept(widget['id'], 'wgt', location.at('id')),
      config:
        typeof type === 'string'
          ? this.widgetConfig(
              type as WidgetType,
              widget['config'],
              widgetIds,
              location.at('config'),
            )
          : widget['config'],
    };
  }

  /**
   * A widget config (CONTRACTS §28.2): table, fields, filter, colors by
   * option or user, filter control defaults; widget ids (`filter_bindings`,
   * `parent_control_id`) through `remapWidgetIds` with the widgets of the
   * same dashboard — one that is not there is dropped, as when a dashboard
   * is duplicated.
   */
  widgetConfig(
    type: WidgetType,
    config: unknown,
    widgetIds: ReadonlyMap<string, string>,
    location: PackageLocation,
  ): unknown {
    if (!isRecord(config) || type === 'text') return config;
    const out: Record<string, unknown> = { ...config };
    const field = (value: unknown, at: PackageLocation) =>
      value === null || value === undefined ? value : this.kept(value, 'fld', at);
    const dimension = (value: unknown, at: PackageLocation) =>
      isRecord(value) ? { ...value, field: field(value['field'], at.at('field')) } : value;
    const metrics = (value: unknown, at: PackageLocation) =>
      Array.isArray(value)
        ? value.map((metric: unknown, index) => dimension(metric, at.at(index)))
        : value;
    out['table_id'] = this.kept(config['table_id'], 'tbl', location.at('table_id'));
    if (type === 'filter_control') {
      const controlField = config['field'];
      out['field'] = field(controlField, location.at('field'));
      if (isRecord(config['default']) && Array.isArray(config['default']['values'])) {
        out['default'] = {
          ...config['default'],
          values: this.controlValues(
            config['control'],
            typeof controlField === 'string' ? controlField : null,
            config['default']['values'],
            location.at('default', 'values'),
          ),
        };
      }
      return remapWidgetIds(type, out, widgetIds);
    }
    if ('filter' in config) out['filter'] = this.filter(config['filter'], location.at('filter'));
    if ('dimension' in config)
      out['dimension'] = dimension(config['dimension'], location.at('dimension'));
    if ('series_dimension' in config) {
      out['series_dimension'] = dimension(
        config['series_dimension'],
        location.at('series_dimension'),
      );
    }
    if ('metrics' in config) out['metrics'] = metrics(config['metrics'], location.at('metrics'));
    if (isRecord(config['compare'])) {
      out['compare'] = {
        ...config['compare'],
        date_field: field(config['compare']['date_field'], location.at('compare', 'date_field')),
      };
    }
    if (isRecord(config['table'])) {
      const table = config['table'];
      const at = location.at('table');
      const next: Record<string, unknown> = { ...table };
      if ('dimension' in table)
        next['dimension'] = dimension(table['dimension'], at.at('dimension'));
      if ('metrics' in table) next['metrics'] = metrics(table['metrics'], at.at('metrics'));
      if (Array.isArray(table['fields'])) {
        next['fields'] = table['fields'].map((id: unknown, index) =>
          field(id, at.at('fields', index)),
        );
      }
      if (isRecord(table['sort'])) next['sort'] = dimension(table['sort'], at.at('sort'));
      out['table'] = next;
    }
    if (isRecord(config['display']) && isRecord(config['display']['colors'])) {
      out['display'] = {
        ...config['display'],
        colors: this.colorKeys(
          config,
          config['display']['colors'],
          location.at('display', 'colors'),
        ),
      };
    }
    return remapWidgetIds(type, out, widgetIds);
  }

  /** `display.colors`: keys that are options of the dimension's field, or users, are rewritten. */
  private colorKeys(
    config: Record<string, unknown>,
    colors: Record<string, unknown>,
    location: PackageLocation,
  ): Record<string, unknown> {
    const owners: string[] = [];
    for (const key of ['series_dimension', 'dimension'] as const) {
      const dimension = config[key];
      if (isRecord(dimension) && typeof dimension['field'] === 'string') {
        const owner = this.options.catalog.optionOwner(dimension['field']);
        if (owner !== null) owners.push(owner);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, color] of Object.entries(colors)) {
      const at = location.at(key);
      if (isId('opt', key)) {
        const owner = owners.find((candidate) => this.options.ids.resolve(key, candidate) !== null);
        const mapped = this.id(key, 'opt', at, true, owner ?? owners[0]);
        if (mapped !== DROP && typeof mapped === 'string') out[mapped] = color;
        continue;
      }
      const user =
        (this.direction === 'export' && isId('usr', key)) ||
        (this.direction === 'import' && key.includes('@'))
          ? this.user(key, 'value', at)
          : key;
      if (user !== DROP && typeof user === 'string') out[user] = color;
    }
    return out;
  }

  private controlValues(
    control: unknown,
    fieldId: string | null,
    values: readonly unknown[],
    location: PackageLocation,
  ): unknown[] {
    if (control === 'select' && fieldId !== null) {
      const owner = this.options.catalog.optionOwner(fieldId);
      return values
        .map((value, index) =>
          owner === null ? value : this.id(value, 'opt', location.at(index), true, owner),
        )
        .filter((value) => value !== DROP);
    }
    if (control === 'user') {
      return values.map((value, index) => {
        const mapped = this.user(value, 'reference', location.at(index));
        return mapped === DROP ? value : mapped;
      });
    }
    return [...values];
  }

  // --- Roles ---------------------------------------------------------------------------

  /** A custom role of `schema/roles.json`. */
  role(role: unknown, location: PackageLocation): unknown {
    if (!isRecord(role)) return role;
    return {
      ...role,
      id: this.kept(role['id'], 'rol', location.at('id')),
      config: this.roleConfig(role['config'], location.at('config')),
    };
  }

  /** A `RoleConfig` (`permissions/src/role-config.ts`). */
  roleConfig(config: unknown, location: PackageLocation): unknown {
    if (!isRecord(config)) return config;
    const out: Record<string, unknown> = { ...config };
    if ('tables' in config) {
      out['tables'] = this.idKeys(
        config['tables'],
        'tbl',
        location.at('tables'),
        (rule, _key, at) => this.tableRule(rule, at),
      );
    }
    if ('dashboards' in config) {
      out['dashboards'] = this.idKeys(config['dashboards'], 'dsh', location.at('dashboards'));
    }
    return out;
  }

  private tableRule(rule: unknown, location: PackageLocation): unknown {
    if (!isRecord(rule)) return rule;
    const out: Record<string, unknown> = { ...rule };
    if (isRecord(rule['view_rule'])) {
      const viewRule = rule['view_rule'];
      out['view_rule'] = {
        ...viewRule,
        visible_views:
          viewRule['visible_views'] === null
            ? null
            : this.idList(
                viewRule['visible_views'],
                'viw',
                location.at('view_rule', 'visible_views'),
              ),
      };
    }
    if (isRecord(rule['record_rule'])) {
      const recordRule = rule['record_rule'];
      const at = location.at('record_rule');
      const next: Record<string, unknown> = { ...recordRule };
      for (const key of ['edit_filter', 'read_filter'] as const) {
        if (isRecord(recordRule[key])) next[key] = this.filter(recordRule[key], at.at(key), 'rule');
      }
      out['record_rule'] = next;
    }
    if (isRecord(rule['field_rule'])) {
      const fieldRule = rule['field_rule'];
      const at = location.at('field_rule');
      out['field_rule'] = {
        ...fieldRule,
        ...('fields' in fieldRule
          ? { fields: this.idKeys(fieldRule['fields'], 'fld', at.at('fields')) }
          : {}),
        ...('option_edit_fields' in fieldRule
          ? {
              option_edit_fields: this.idList(
                fieldRule['option_edit_fields'],
                'fld',
                at.at('option_edit_fields'),
              ),
            }
          : {}),
        ...('file_download_fields' in fieldRule
          ? {
              file_download_fields: this.idList(
                fieldRule['file_download_fields'],
                'fld',
                at.at('file_download_fields'),
              ),
            }
          : {}),
      };
    }
    return out;
  }

  // --- Automations ---------------------------------------------------------------------

  /**
   * An automation of `schema/automations.json`: its id, its definition and
   * the slots it no longer fills (`detached`). Export: secret, identity,
   * group and webhook ids become `null`, listed with their name. Import:
   * those slots are `null` whatever the package holds; the names the
   * package lists are kept for the report.
   */
  automation(automation: unknown, location: PackageLocation): RewrittenAutomation {
    if (!isRecord(automation)) return { automation: {}, detached: [] };
    const definitionAt = location.at('definition');
    const listed = new Map<string, PackageDetached>();
    for (const item of arrayOf(automation['detached'])) {
      if (isRecord(item) && typeof item['path'] === 'string') {
        listed.set(item['path'], item as unknown as PackageDetached);
      }
    }
    const walk = new AutomationWalk(this, definitionAt, listed);
    const definition = walk.definition(automation['definition']);
    return {
      automation: {
        ...automation,
        id: this.kept(automation['id'], 'aut', location.at('id')),
        definition,
        detached: walk.detached,
      },
      detached: walk.detached,
    };
  }

  /** @internal Used by the automation walk: empties one slot of a definition. */
  detachSlot(
    container: Record<string, unknown>,
    key: string,
    kind: BasePackageDetachedKind,
    path: string,
    listed: ReadonlyMap<string, PackageDetached>,
    detached: PackageDetached[],
  ): void {
    const value = container[key];
    if (this.direction === 'export') {
      if (typeof value === 'string' && value !== '') {
        detached.push({ path, kind, name: this.options.detachedName?.(kind, value) ?? '' });
        container[key] = null;
      }
      return;
    }
    // Import: never an id of the target organization, whatever the package holds.
    const entry = listed.get(path);
    if (entry !== undefined || (value !== null && value !== undefined)) {
      detached.push({ path, kind, name: typeof entry?.name === 'string' ? entry.name : '' });
    }
    if (key in container) container[key] = null;
  }

  /** @internal */
  mapId(
    value: unknown,
    prefix: PackageIdPrefix,
    location: PackageLocation,
    droppable: boolean,
    owner?: string,
  ): unknown {
    return this.id(value, prefix, location, droppable, owner);
  }

  /** @internal */
  mapIdList(value: unknown, prefix: PackageIdPrefix, location: PackageLocation): unknown {
    return this.idList(value, prefix, location);
  }

  /** @internal */
  mapUsers(value: unknown, mode: PackageUserMode, location: PackageLocation): unknown {
    return this.userList(value, mode, location);
  }

  /** @internal An automation value (SPEC §11.4); `{ literal }` by the kind of `targetField`. */
  automationValue(value: unknown, location: PackageLocation, targetField: string | null): unknown {
    if (!isRecord(value)) return value;
    if ('field' in value) {
      return { ...value, field: this.kept(value['field'], 'fld', location.at('field')) };
    }
    if ('template' in value) {
      return { ...value, template: this.template(value['template'], location.at('template')) };
    }
    if ('digest' in value && isRecord(value['digest'])) {
      return { ...value, digest: this.digest(value['digest'], location.at('digest')) };
    }
    if ('step' in value && typeof value['path'] === 'string') {
      return { ...value, path: this.stepPath(value['path'], location.at('path')) };
    }
    if ('literal' in value) {
      return {
        ...value,
        literal: this.literalFor(targetField, value['literal'], location.at('literal')),
      };
    }
    return value;
  }

  /** @internal A `digest` of a `find_records` step. */
  digest(digest: Record<string, unknown>, location: PackageLocation): Record<string, unknown> {
    return {
      ...digest,
      row_template: this.template(digest['row_template'], location.at('row_template')),
    };
  }

  /** A value path into step output (`records[0].fields.fld_…`): field id keys are rewritten. */
  private stepPath(path: string, location: PackageLocation): string {
    const segments = parseValuePath(path);
    if (segments === null) return path;
    let text = '';
    for (const segment of segments) {
      if (typeof segment === 'number') {
        text += `[${String(segment)}]`;
        continue;
      }
      const mapped = isId('fld', segment) ? this.kept(segment, 'fld', location) : segment;
      text += `${text === '' ? '' : '.'}${typeof mapped === 'string' ? mapped : segment}`;
    }
    return text;
  }

  // --- Tables, records, links, files --------------------------------------------------

  /** A table of `schema/tables.json` with its fields and their options. */
  table(table: unknown, location: PackageLocation): unknown {
    if (!isRecord(table)) return table;
    return {
      ...table,
      id: this.kept(table['id'], 'tbl', location.at('id')),
      primary_field_id: this.kept(
        table['primary_field_id'],
        'fld',
        location.at('primary_field_id'),
      ),
      fields: Array.isArray(table['fields'])
        ? table['fields'].map((field: unknown, index) =>
            this.field(field, location.at('fields', index)),
          )
        : table['fields'],
    };
  }

  /** A field: its id and options. */
  field(field: unknown, location: PackageLocation): unknown {
    if (!isRecord(field) || typeof field['id'] !== 'string' || typeof field['type'] !== 'string') {
      return field;
    }
    return {
      ...field,
      id: this.kept(field['id'], 'fld', location.at('id')),
      options: this.fieldOptions(
        { id: field['id'], type: field['type'], options: field['options'] },
        location.at('options'),
      ),
    };
  }

  /** A junction row (`links/<fld>.ndjson`). */
  link(
    link: { readonly a: string; readonly b: string; readonly position: number },
    location: PackageLocation,
  ) {
    return {
      a: this.kept(link.a, 'rec', location.at('a')) as string,
      b: this.kept(link.b, 'rec', location.at('b')) as string,
      position: link.position,
    };
  }

  /** A file of `files/attachments.json`. */
  file(file: unknown, location: PackageLocation): unknown {
    if (!isRecord(file)) return file;
    const out: Record<string, unknown> = {
      ...file,
      id: this.kept(file['id'], 'att', location.at('id')),
    };
    const refs = [
      ['table_id', 'tbl'],
      ['field_id', 'fld'],
      ['record_id', 'rec'],
      ['view_id', 'viw'],
      ['automation_id', 'aut'],
    ] as const;
    for (const [key, prefix] of refs) {
      if (key in file) out[key] = this.kept(file[key], prefix, location.at(key));
    }
    return out;
  }

  /**
   * The values of one record (`fields`, keyed by field id) for the other
   * side: keys and values rewritten; on import a key must be a field of
   * `tableId` with a value of its own (`INVALID_ENTRY` otherwise).
   */
  recordFields(
    fields: Readonly<Record<string, unknown>>,
    tableId: string,
    location: PackageLocation,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const at = location.at(key);
      const field = this.options.catalog.field(key);
      if (
        field !== undefined &&
        (field.tableId !== tableId || !isPackageValueFieldType(field.type))
      ) {
        if (this.direction === 'import') {
          this.problems.add(
            'INVALID_ENTRY',
            at.toString(),
            'A record holds a value for a field that has no value of its own here.',
          );
        }
        continue;
      }
      const mapped = this.id(key, 'fld', at, true);
      if (mapped === DROP) continue;
      out[typeof mapped === 'string' ? mapped : key] = this.cellValue(key, value, at);
    }
    return out;
  }

  /** Export: the body images (`asset:att_…`) of the definition's `send_email` steps. */
  emailAssets(definition: unknown, location: PackageLocation): unknown {
    if (!isRecord(definition)) return definition;
    let references: ReturnType<typeof emailAssetReferencesOf>;
    try {
      references = emailAssetReferencesOf(definition as unknown as AutomationDefinition);
    } catch {
      this.problems.add('INVALID_DEFINITION', location.toString(), 'An automation cannot be read.');
      return definition;
    }
    const mapping = new Map<Id<'att'>, Id<'att'>>();
    for (const reference of references) {
      const mapped = this.kept(reference.assetId, 'att', location);
      if (typeof mapped === 'string' && mapped !== reference.assetId) {
        mapping.set(reference.assetId, mapped as Id<'att'>);
      }
    }
    return replaceEmailAssetIds(definition as unknown as AutomationDefinition, mapping);
  }
}

/** The walk of one automation definition (trigger, condition, actions and `if` branches). */
class AutomationWalk {
  readonly detached: PackageDetached[] = [];

  constructor(
    private readonly rewriter: PackageRewriter,
    private readonly root: PackageLocation,
    private readonly listed: ReadonlyMap<string, PackageDetached>,
  ) {}

  private detach(
    container: Record<string, unknown>,
    key: string,
    kind: BasePackageDetachedKind,
    location: PackageLocation,
  ): void {
    this.rewriter.detachSlot(
      container,
      key,
      kind,
      location.at(key).dottedFrom(this.root),
      this.listed,
      this.detached,
    );
  }

  definition(definition: unknown): unknown {
    if (!isRecord(definition)) return definition;
    const out: Record<string, unknown> = { ...definition };
    out['trigger'] = this.trigger(definition['trigger'], this.root.at('trigger'));
    if (isRecord(definition['condition'])) {
      out['condition'] = this.rewriter.filter(
        definition['condition'],
        this.root.at('condition'),
        'automation',
      );
    }
    out['actions'] = this.actions(definition['actions'], this.root.at('actions'));
    return this.rewriter.emailAssets(out, this.root);
  }

  private trigger(trigger: unknown, location: PackageLocation): unknown {
    if (!isRecord(trigger)) return trigger;
    const out: Record<string, unknown> = { ...trigger };
    const r = this.rewriter;
    if ('table_id' in trigger)
      out['table_id'] = r.mapId(trigger['table_id'], 'tbl', location.at('table_id'), false);
    if ('field_id' in trigger)
      out['field_id'] = r.mapId(trigger['field_id'], 'fld', location.at('field_id'), false);
    if ('view_id' in trigger)
      out['view_id'] = r.mapId(trigger['view_id'], 'viw', location.at('view_id'), false);
    if ('watch_fields' in trigger) {
      out['watch_fields'] = Array.isArray(trigger['watch_fields'])
        ? trigger['watch_fields'].map((id: unknown, index) =>
            r.mapId(id, 'fld', location.at('watch_fields', index), false),
          )
        : trigger['watch_fields'];
    }
    for (const key of ['condition', 'enabled_when'] as const) {
      if (isRecord(trigger[key])) out[key] = r.filter(trigger[key], location.at(key), 'automation');
    }
    if (trigger['type'] === 'webhook.received') {
      this.detach(out, 'incoming_webhook_id', 'incoming_webhook', location);
    }
    return out;
  }

  private actions(actions: unknown, location: PackageLocation): unknown {
    if (!Array.isArray(actions)) return actions;
    return actions.map((action: unknown, index) => this.action(action, location.at(index)));
  }

  private action(action: unknown, location: PackageLocation): unknown {
    if (!isRecord(action) || !isRecord(action['config'])) return action;
    const config: Record<string, unknown> = { ...action['config'] };
    const at = location.at('config');
    const r = this.rewriter;
    const value = (key: string, target: string | null = null) => {
      if (key in config) config[key] = r.automationValue(config[key], at.at(key), target);
    };
    const template = (key: string) => {
      if (isRecord(config[key])) {
        const text = config[key];
        const next: Record<string, unknown> = {
          ...text,
          template: r.template(text['template'], at.at(key, 'template')),
        };
        if (isRecord(text['digest']))
          next['digest'] = r.digest(text['digest'], at.at(key, 'digest'));
        config[key] = next;
      }
    };
    const tableId = (key = 'table_id') => {
      if (key in config) config[key] = r.mapId(config[key], 'tbl', at.at(key), false);
    };
    const fieldValues = () => {
      if (!isRecord(config['fields'])) return;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(config['fields'])) {
        const mapped = r.mapId(key, 'fld', at.at('fields', key), false);
        out[typeof mapped === 'string' ? mapped : key] = r.automationValue(
          item,
          at.at('fields', key),
          key,
        );
      }
      config['fields'] = out;
    };
    const filterOf = (key: string) => {
      if (isRecord(config[key])) config[key] = r.filter(config[key], at.at(key), 'automation');
    };
    switch (action['type']) {
      case 'create_record':
        tableId();
        fieldValues();
        break;
      case 'update_record':
        tableId();
        value('record_id', null);
        if (isRecord(config['record_id']) && 'literal' in config['record_id']) {
          config['record_id'] = {
            ...config['record_id'],
            literal: r.mapId(
              config['record_id']['literal'],
              'rec',
              at.at('record_id', 'literal'),
              false,
            ),
          };
        }
        fieldValues();
        break;
      case 'update_records':
        tableId();
        filterOf('filter');
        fieldValues();
        break;
      case 'find_records':
        tableId();
        filterOf('filter');
        if (Array.isArray(config['sort'])) {
          config['sort'] = config['sort'].map((item: unknown, index) =>
            isRecord(item)
              ? {
                  ...item,
                  field: r.mapId(item['field'], 'fld', at.at('sort', index, 'field'), false),
                }
              : item,
          );
        }
        if ('fields' in config) {
          config['fields'] = Array.isArray(config['fields'])
            ? config['fields'].map((id: unknown, index) =>
                r.mapId(id, 'fld', at.at('fields', index), false),
              )
            : config['fields'];
        }
        break;
      case 'delay':
        value('until');
        filterOf('recheck_condition');
        break;
      case 'send_email':
        this.detach(config, 'identity_id', 'email_identity', at);
        for (const key of ['to', 'cc', 'bcc'] as const) {
          if (Array.isArray(config[key])) {
            config[key] = config[key].map((item: unknown, index) =>
              r.automationValue(item, at.at(key, index), null),
            );
          }
        }
        if (isRecord(config['reply_to']) && !('identity_id' in config['reply_to'])) {
          config['reply_to'] = r.automationValue(config['reply_to'], at.at('reply_to'), null);
        } else if ('reply_to' in config) {
          // A sending identity as Reply-To: detached, the reply goes to the default.
          const replyTo: Record<string, unknown> = isRecord(config['reply_to'])
            ? { ...config['reply_to'] }
            : { identity_id: null };
          this.detach(replyTo, 'identity_id', 'email_identity', at.at('reply_to'));
          if (isRecord(config['reply_to'])) config['reply_to'] = null;
        }
        template('subject');
        template('body');
        if (Array.isArray(config['attachments'])) {
          config['attachments'] = config['attachments'].map((item: unknown, index) =>
            isRecord(item)
              ? {
                  ...item,
                  field: r.mapId(item['field'], 'fld', at.at('attachments', index, 'field'), false),
                }
              : item,
          );
        }
        break;
      case 'send_notification':
        if (Array.isArray(config['recipients'])) {
          config['recipients'] = config['recipients'].map((item: unknown, index) => {
            const itemAt = at.at('recipients', index);
            if (!isRecord(item)) return item;
            if ('user_ids' in item) {
              return {
                ...item,
                user_ids: r.mapUsers(item['user_ids'], 'reference', itemAt.at('user_ids')),
              };
            }
            if ('group_id' in item) {
              const next: Record<string, unknown> = { ...item };
              this.detach(next, 'group_id', 'group', itemAt);
              return next;
            }
            return r.automationValue(item, itemAt, null);
          });
        }
        template('title');
        template('body');
        break;
      case 'send_telegram':
        this.detach(config, 'secret_id', 'secret', at);
        value('chat_id');
        template('text');
        break;
      case 'http_request':
        value('url');
        for (const key of ['query', 'headers'] as const) {
          if (Array.isArray(config[key])) {
            config[key] = config[key].map((item: unknown, index) =>
              isRecord(item)
                ? {
                    ...item,
                    value: r.automationValue(item['value'], at.at(key, index, 'value'), null),
                  }
                : item,
            );
          }
        }
        if (isRecord(config['auth'])) {
          const auth: Record<string, unknown> = { ...config['auth'] };
          this.detach(auth, 'secret_id', 'secret', at.at('auth'));
          config['auth'] = auth;
        }
        if (isRecord(config['body'])) {
          const body: Record<string, unknown> = { ...config['body'] };
          if ('value' in body)
            body['value'] = r.automationValue(body['value'], at.at('body', 'value'), null);
          if (Array.isArray(body['fields'])) {
            body['fields'] = body['fields'].map((item: unknown, index) =>
              isRecord(item)
                ? {
                    ...item,
                    value: r.automationValue(
                      item['value'],
                      at.at('body', 'fields', index, 'value'),
                      null,
                    ),
                  }
                : item,
            );
          }
          config['body'] = body;
        }
        this.detach(config, 'signing_secret_id', 'secret', at);
        break;
      case 'run_n8n_workflow':
        value('url');
        this.detach(config, 'signing_secret_id', 'secret', at);
        if (Array.isArray(config['fields'])) {
          config['fields'] = config['fields'].map((id: unknown, index) =>
            r.mapId(id, 'fld', at.at('fields', index), false),
          );
        }
        break;
      case 'ai_generate_text':
        config['prompt'] = r.template(config['prompt'], at.at('prompt'));
        if (config['target_field_id'] !== null && config['target_field_id'] !== undefined) {
          config['target_field_id'] = r.mapId(
            config['target_field_id'],
            'fld',
            at.at('target_field_id'),
            false,
          );
        }
        break;
      case 'ai_classify':
        config['input'] = r.template(config['input'], at.at('input'));
        config['target_field_id'] = r.mapId(
          config['target_field_id'],
          'fld',
          at.at('target_field_id'),
          false,
        );
        break;
      case 'if':
        if (Array.isArray(config['conditions'])) {
          config['conditions'] = config['conditions'].map((condition: unknown, index) => {
            const conditionAt = at.at('conditions', index);
            if (!isRecord(condition)) return condition;
            if ('filter' in condition) {
              return {
                ...condition,
                filter: r.filter(condition['filter'], conditionAt.at('filter'), 'automation'),
              };
            }
            return {
              ...condition,
              value: r.automationValue(condition['value'], conditionAt.at('value'), null),
              ...('compare' in condition
                ? {
                    compare: r.automationValue(
                      condition['compare'],
                      conditionAt.at('compare'),
                      null,
                    ),
                  }
                : {}),
            };
          });
        }
        config['then'] = this.actions(config['then'], at.at('then'));
        config['else'] = this.actions(config['else'], at.at('else'));
        break;
      case 'delete_record':
        break;
      default:
        r.problems.add(
          'INVALID_DEFINITION',
          location.at('type').toString(),
          'An automation has an action this version does not know.',
        );
        break;
    }
    return { ...action, config };
  }
}
