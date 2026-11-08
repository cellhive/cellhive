import {
  aiFieldOptionsSchema,
  AUTOMATION_DISALLOWED_FUNCTIONS,
  type AiFieldOptions,
  type AiFieldReaderOptions,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import {
  checkTemplate,
  renderTemplateNames,
  type CheckedPlaceholder,
  type FormulaDependency,
} from '@cellhive/formula-engine';

import {
  snapshotOfBase,
  type BaseSchemaRows,
  type SchemaReadability,
} from '../../computed/definition/schema-rows.js';
import {
  edgesOf,
  type FieldDependencyEdge,
} from '../../computed/graph/field-dependencies.repository.js';
import { AppError } from '../../errors/app-error.js';
import { zodIssuesToProblemErrors } from '../../errors/zod-issues.js';

import { aiOptionsOf, isAiField } from './options.js';
import { aiAnalysisOf, aiCrossRecordSources, aiReadFieldIds } from './sources.js';

import type { AnalysisOf } from '../../records/computed/read/references.js';

/** What the person saving an AI field may reference (T910; permission checks belong to the caller). */
export interface AiFieldContext {
  /** Tables and fields the saver can read; absent: every one (the system). */
  readonly readable?: SchemaReadability;
  /**
   * How the prompt is written: `display` (`{{ [Field name] }}`, the API,
   * default) or `stored` (`{{ [fld_…] }}`, a `.chbase` import, whose
   * prompts carry the ids of the new base — T1019).
   */
  readonly expressionForm?: 'display' | 'stored';
}

/** Field types a prompt may not read: no text value (attachment, button) or another AI field. */
const NOT_A_SOURCE: ReadonlySet<string> = new Set(['attachment', 'button']);

const PATH = 'options.ai.prompt';

function failed(errors: ProblemErrorItem[]): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: 'The AI settings of the field are not valid.',
    errors,
  });
}

/** What the prompt rule needs to know of a source field. */
export interface AiPromptSource {
  readonly id: string;
  readonly type: string;
  readonly options: unknown;
}

/**
 * The sources of an AI prompt — one rule for AI fields (T910) and AI
 * actions (T911): every placeholder reads fields of the same record only
 * (`same_row`, and a formula/lookup only when it reads the same record
 * alone, transitively — `crossRecord`; else `CROSS_TABLE_NOT_SUPPORTED`),
 * never an attachment, a button, another AI field or `selfId`, nor anything
 * that is not a field (`INVALID_FIELD_TYPE`). Problems at `path` with the
 * placeholder's `params.position`; the dependencies that pass are returned.
 */
export function aiPromptSourceProblems(
  placeholders: readonly CheckedPlaceholder[],
  rule: {
    readonly path: string;
    readonly sourceOf: (fieldId: string) => AiPromptSource | undefined;
    readonly crossRecord: (fieldId: string) => boolean;
    readonly selfId?: string;
  },
): { readonly problems: ProblemErrorItem[]; readonly dependencies: FormulaDependency[] } {
  const problems: ProblemErrorItem[] = [];
  const dependencies = placeholders.flatMap((placeholder) => {
    const at = { position: { start: placeholder.start, length: placeholder.length } };
    return placeholder.dependencies.filter((dependency) => {
      const source = rule.sourceOf(dependency.field_id);
      // A formula/lookup reading another record or table, at any depth, is no same-record source.
      if (dependency.kind !== 'same_row' || rule.crossRecord(dependency.field_id)) {
        problems.push({
          path: rule.path,
          code: 'CROSS_TABLE_NOT_SUPPORTED',
          message: 'A prompt can only read fields of the same record',
          params: at,
        });
        return false;
      }
      if (
        source === undefined ||
        source.id === rule.selfId ||
        NOT_A_SOURCE.has(source.type) ||
        isAiField(source)
      ) {
        problems.push({
          path: rule.path,
          code: 'INVALID_FIELD_TYPE',
          message: 'A prompt cannot read this field (attachment, button, AI field or itself)',
          params: { ...at, ...(source === undefined ? {} : { type: source.type }) },
        });
        return false;
      }
      return true;
    });
  });
  return { problems, dependencies };
}

/**
 * `options.ai` of a `text`/`select` field being saved (BACKLOG T910,
 * CONTRACTS §29.5): its prompt, typed with names (display form; ids for a
 * `.chbase` import, `context.expressionForm = 'stored'`), checked
 * like an automation template against what the saver reads — a field they
 * cannot read is a field that does not exist (`UNKNOWN_FIELD`, like a
 * formula, C§13) — then stored with field ids. Only fields of the same
 * record (`same_row`, and a formula/lookup only when it reads the same
 * record alone, transitively; `CROSS_TABLE_NOT_SUPPORTED` otherwise), never an
 * attachment, a button, another AI field or the field itself
 * (`INVALID_FIELD_TYPE`); not on a primary field. Returns the stored options
 * and the dependency edges (`same_row`) of the field.
 */
export function prepareAiOptions(
  value: unknown,
  rows: BaseSchemaRows,
  field: { readonly id: Id<'fld'>; readonly tableId: Id<'tbl'>; readonly isPrimary: boolean },
  context: AiFieldContext = {},
): { readonly ai: AiFieldOptions; readonly edges: FieldDependencyEdge[] } {
  const parsed = aiFieldOptionsSchema.safeParse(value);
  if (!parsed.success) {
    throw failed(
      zodIssuesToProblemErrors(parsed.error.issues).map((item) => ({
        ...item,
        path: item.path === '' ? 'options.ai' : `options.ai.${item.path}`,
      })),
    );
  }
  if (field.isPrimary) {
    throw failed([
      {
        path: 'options.ai',
        code: 'INVALID_FIELD_TYPE',
        message: 'The primary field cannot be an AI field',
      },
    ]);
  }
  const snapshot = snapshotOfBase(rows, field.tableId, context.readable);
  const check = checkTemplate(parsed.data.prompt, snapshot, {
    form: context.expressionForm ?? 'display',
    allowTables: false,
    disallow: AUTOMATION_DISALLOWED_FUNCTIONS,
  });
  const errors: ProblemErrorItem[] = check.errors.map((problem) => ({
    path: PATH,
    code: problem.code,
    message: problem.message,
    params: { ...problem.params },
  }));
  const byId = new Map(rows.fields.map((row) => [row.id as string, row]));
  const analysisOf = aiAnalysisOf(rows);
  const { problems, dependencies } = aiPromptSourceProblems(check.placeholders, {
    path: PATH,
    sourceOf: (id) => byId.get(id),
    crossRecord: (id) => aiCrossRecordSources([id], rows, analysisOf).length > 0,
    selfId: field.id,
  });
  errors.push(...problems);
  // `stored` is `null` exactly when `check.errors` is not empty.
  if (errors.length > 0 || check.stored === null) throw failed(errors);
  return { ai: { ...parsed.data, prompt: check.stored }, edges: edgesOf(field.id, dependencies) };
}

/**
 * Who reads an AI field through the field API, `schema.changed` or any
 * other output of its configuration (CONTRACTS §13, §29.5).
 */
export interface AiConfigReader {
  /** Schema rights on the field's table: base admin or table `manage`. */
  readonly canManage: boolean;
  readonly readable: SchemaReadability;
}

/**
 * The fields a reader must read to see the configuration of `field`: every
 * **active** field flowing into its prompt (`aiReadFieldIds` — its sources
 * and what computed sources read on the same record); a deleted source
 * shows as `#REF[fld_…]` and is left out, like the definition of a formula
 * (`[]` for a field that is not an AI field).
 */
export function aiConfigFieldIds(
  field: { readonly type: string; readonly options: unknown },
  rows: BaseSchemaRows,
  analysisOf?: AnalysisOf,
): Id<'fld'>[] {
  const active = new Set<string>(rows.fields.map((row) => row.id));
  return aiReadFieldIds(field, rows, analysisOf).filter((id) => active.has(id));
}

/**
 * Whether `reader` gets the whole `options.ai` of an AI field of `tableId`
 * and its `ai_state` — the rule of a formula's definition (CONTRACTS §13):
 * schema rights on the table **and** every field of `configFieldIds`
 * ({@link aiConfigFieldIds}) readable.
 */
export function aiConfigVisible(
  reader: AiConfigReader,
  tableId: Id<'tbl'>,
  configFieldIds: readonly Id<'fld'>[],
): boolean {
  return reader.canManage && configFieldIds.every((id) => reader.readable.field(tableId, id));
}

/**
 * `options.ai` of `field` for one reader (`null`: not an AI field) — the
 * one serializer of every output of the configuration (CONTRACTS §29.5):
 * when {@link aiConfigVisible}, the whole configuration with the prompt in
 * the reader's names (a deleted field shows as `#REF[fld_…]`); otherwise
 * `{ task }` only.
 */
export function aiOptionsForReader(
  field: {
    readonly table_id: Id<'tbl'>;
    readonly type: string;
    readonly options: unknown;
  },
  rows: BaseSchemaRows,
  reader: AiConfigReader,
): AiFieldReaderOptions | null {
  const ai = aiOptionsOf(field);
  if (ai === null) return null;
  if (!aiConfigVisible(reader, field.table_id, aiConfigFieldIds(field, rows))) {
    return { task: ai.task };
  }
  return {
    ...ai,
    prompt: renderTemplateNames(ai.prompt, snapshotOfBase(rows, field.table_id, reader.readable)),
  };
}
