import {
  aiFieldOptionsSchema,
  AUTOMATION_DISALLOWED_FUNCTIONS,
  type AiFieldOptions,
  type Id,
  type ProblemErrorItem,
} from '@cellhive/contracts';
import { checkTemplate, renderTemplateNames } from '@cellhive/formula-engine';

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

import { isAiField } from './options.js';
import { aiAnalysisOf, aiCrossRecordSources } from './sources.js';

/** What the person saving an AI field may reference (T910; permission checks belong to the caller). */
export interface AiFieldContext {
  /** Tables and fields the saver can read; absent: every one (the system). */
  readonly readable?: SchemaReadability;
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

/**
 * `options.ai` of a `text`/`select` field being saved (BACKLOG T910,
 * CONTRACTS §29.5): its prompt, typed with names (display form), checked
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
    form: 'display',
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
  const dependencies = check.placeholders.flatMap((placeholder) => {
    const at = { position: { start: placeholder.start, length: placeholder.length } };
    return placeholder.dependencies.filter((dependency) => {
      const source = byId.get(dependency.field_id);
      // A formula/lookup reading another record or table, at any depth, is no same-record source.
      const crossRecord = aiCrossRecordSources([dependency.field_id], rows, analysisOf).length > 0;
      if (dependency.kind !== 'same_row' || crossRecord) {
        errors.push({
          path: PATH,
          code: 'CROSS_TABLE_NOT_SUPPORTED',
          message: 'A prompt can only read fields of the same record',
          params: at,
        });
        return false;
      }
      if (
        source === undefined ||
        source.id === field.id ||
        NOT_A_SOURCE.has(source.type) ||
        isAiField(source)
      ) {
        errors.push({
          path: PATH,
          code: 'INVALID_FIELD_TYPE',
          message: 'A prompt cannot read this field (attachment, button, AI field or itself)',
          params: { ...at, ...(source === undefined ? {} : { type: source.type }) },
        });
        return false;
      }
      return true;
    });
  });
  // `stored` is `null` exactly when `check.errors` is not empty.
  if (errors.length > 0 || check.stored === null) throw failed(errors);
  return { ai: { ...parsed.data, prompt: check.stored }, edges: edgesOf(field.id, dependencies) };
}

/**
 * `options.ai` for a reader of the field API: the prompt with current names
 * (a field the reader cannot read, or deleted, shows as `#REF[fld_…]`).
 */
export function aiOptionsForReader(
  ai: AiFieldOptions,
  rows: BaseSchemaRows,
  tableId: Id<'tbl'>,
  readable?: SchemaReadability,
): AiFieldOptions {
  return { ...ai, prompt: renderTemplateNames(ai.prompt, snapshotOfBase(rows, tableId, readable)) };
}
