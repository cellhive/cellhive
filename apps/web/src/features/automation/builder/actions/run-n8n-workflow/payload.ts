import type { FieldDto, N8nWorkflowPayload } from '@cellhive/contracts';

/**
 * The example payload of a `run_n8n_workflow` step (BACKLOG T613, SPEC
 * §13.3, CONTRACTS §21 `N8nWorkflowPayload`), built in the browser from the
 * step and the schema — no record is read: values are placeholders naming
 * each field's type. The real payload is built when the step runs, with
 * what `run_as` reads then.
 */

/** Fields a `run_n8n_workflow` step can send (a button has no stored value). */
export function sendableFields(fields: readonly FieldDto[]): FieldDto[] {
  return fields.filter((field) => field.type !== 'button');
}

/** The fields of the payload: the chosen ones in table order, or every sendable one. */
export function payloadFields(
  fields: readonly FieldDto[],
  chosen: readonly string[] | null,
): FieldDto[] {
  const sendable = sendableFields(fields);
  if (chosen === null) return sendable;
  const set = new Set(chosen);
  return sendable.filter((field) => set.has(field.id));
}

export interface PayloadPreviewInput {
  readonly triggerType: string;
  readonly automationName: string;
  readonly baseName: string;
  /** The trigger table, `null` without a trigger record (`schedule`, `webhook.received`). */
  readonly table: { readonly id: string; readonly name: string } | null;
  readonly fields: readonly FieldDto[];
  readonly includeChanges: boolean;
}

const EXAMPLE_TIME = '2026-01-01T00:00:00.000Z';

function placeholder(field: FieldDto): string {
  return `<${field.type}>`;
}

export function n8nPayloadPreview(input: PayloadPreviewInput): N8nWorkflowPayload {
  const record =
    input.table === null
      ? null
      : {
          id: 'rec_…',
          fields: Object.fromEntries(input.fields.map((field) => [field.name, placeholder(field)])),
          fields_by_id: Object.fromEntries(
            input.fields.map((field) => [field.id, placeholder(field)]),
          ),
        };
  const [first] = input.fields;
  const changes =
    input.triggerType === 'record.updated' && input.includeChanges && record !== null
      ? first === undefined
        ? {}
        : { [first.name]: { from: placeholder(first), to: placeholder(first) } }
      : null;
  return {
    event: {
      id: input.triggerType === 'schedule' ? null : 'evt_…',
      type: input.triggerType,
      entity_id: input.table === null ? null : 'rec_…',
      created_at: EXAMPLE_TIME,
    },
    automation: { id: 'aut_…', name: input.automationName, run_id: 'run_…' },
    base: { id: 'bse_…', name: input.baseName },
    table: input.table,
    record,
    changes,
  };
}
