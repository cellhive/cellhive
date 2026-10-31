import { z } from 'zod';

/** A JSON Schema node, as produced by `z.toJSONSchema`. */
export type JsonSchemaNode = Record<string, unknown>;

/** Deepest nesting of objects and arrays a strict schema may have (OpenAI structured outputs). */
export const LLM_SCHEMA_MAX_DEPTH = 10;

/**
 * The JSON Schema of an LLM output schema (CONTRACTS §29.7, ADR-39):
 * `schema` is sent as `response_format.json_schema.schema` (or quoted in the
 * prompt on the lower rungs); `source` is the plain conversion, kept to
 * read optional keys back ({@link dropNullOptionals}); `wrapped` when the
 * zod root is not an object and the answer is `{ "result": … }`.
 */
export interface LlmJsonSchema {
  readonly schema: JsonSchemaNode;
  readonly source: JsonSchemaNode;
  readonly wrapped: boolean;
}

/**
 * Keywords of the strict subset kept in the schema; the others (`default`,
 * `minLength`, `pattern`, `format`…) are dropped — zod still checks them,
 * and a provider refusing an unknown keyword would cost a rung.
 */
const KEPT = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'enum',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
]);

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replaces `#/$defs/…` references by their definition; recursion is refused (flat schemas only). */
function inline(node: unknown, defs: JsonSchemaNode, seen: readonly string[]): unknown {
  if (Array.isArray(node)) return node.map((item) => inline(item, defs, seen));
  if (!isNode(node)) return node;
  const ref = node['$ref'];
  if (typeof ref === 'string') {
    const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : null;
    if (name === null || seen.includes(name) || !isNode(defs[name])) {
      throw new RangeError(`LLM schemas must be flat: unsupported reference ${ref}`);
    }
    const rest = { ...node };
    delete rest['$ref'];
    return { ...(inline(defs[name], defs, [...seen, name]) as JsonSchemaNode), ...rest };
  }
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key !== '$defs') out[key] = inline(value, defs, seen);
  }
  return out;
}

function acceptsNull(node: JsonSchemaNode): boolean {
  const type = node['type'];
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  const anyOf = node['anyOf'];
  return Array.isArray(anyOf) && anyOf.some((branch) => isNode(branch) && acceptsNull(branch));
}

/** An optional key becomes required and nullable (strict mode lists every key in `required`). */
function nullable(node: JsonSchemaNode): JsonSchemaNode {
  if (acceptsNull(node)) return node;
  const type = node['type'];
  // A type list for a scalar; `anyOf` for objects, arrays and enums (an enum would refuse `null`).
  if (typeof type === 'string' && type !== 'object' && type !== 'array' && !('enum' in node)) {
    return { ...node, type: [type, 'null'] };
  }
  return { anyOf: [node, { type: 'null' }] };
}

function strict(node: JsonSchemaNode, depth: number): JsonSchemaNode {
  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (KEPT.has(key)) out[key] = value;
  }
  // `const` → one-value `enum` (always supported); `oneOf` → `anyOf` (strict mode has no `oneOf`).
  if ('const' in node) out['enum'] = [node['const']];
  const branches = node['anyOf'] ?? node['oneOf'];
  if (Array.isArray(branches)) {
    out['anyOf'] = branches.map((branch) => strict(branch as JsonSchemaNode, depth));
  }
  // Safe-integer bounds of `z.int()` say nothing to a model.
  if (out['minimum'] === Number.MIN_SAFE_INTEGER) delete out['minimum'];
  if (out['maximum'] === Number.MAX_SAFE_INTEGER) delete out['maximum'];

  const isObject = node['type'] === 'object' || isNode(node['properties']);
  const isArray = node['type'] === 'array';
  if ((isObject || isArray) && depth > LLM_SCHEMA_MAX_DEPTH) {
    throw new RangeError(`LLM schemas nest at most ${String(LLM_SCHEMA_MAX_DEPTH)} levels`);
  }
  if (isObject) {
    if (!isNode(node['properties'])) {
      throw new RangeError('LLM schemas need fixed keys: maps (z.record) are not supported');
    }
    const required = new Set(Array.isArray(node['required']) ? node['required'] : []);
    const properties: JsonSchemaNode = {};
    for (const [key, value] of Object.entries(node['properties'])) {
      const child = strict(value as JsonSchemaNode, depth + 1);
      properties[key] = required.has(key) ? child : nullable(child);
    }
    out['properties'] = properties;
    out['required'] = Object.keys(properties);
    out['additionalProperties'] = false;
  }
  if (isArray) {
    const prefix = node['prefixItems'];
    if (Array.isArray(prefix)) {
      // A tuple (`[field, op, value]`): strict mode has no `prefixItems`, so any position
      // takes any member; zod still checks each position.
      const members = prefix.map((item) => strict(item as JsonSchemaNode, depth + 1));
      out['items'] = members.length === 1 ? members[0] : { anyOf: members };
      out['minItems'] = prefix.length;
      out['maxItems'] = prefix.length;
    } else if (isNode(node['items'])) {
      out['items'] = strict(node['items'], depth + 1);
    }
  }
  return out;
}

/**
 * Converts the zod schema of an LLM answer to the strict JSON Schema subset
 * of structured outputs (research §2.3): `z.toJSONSchema` (output side),
 * then `$defs` inlined, `oneOf` → `anyOf`, optional keys → required +
 * `null`, `additionalProperties: false` on every object, a tuple → array of
 * its members, unsupported keywords dropped, a non-object root wrapped in
 * `{ result }`, at most {@link LLM_SCHEMA_MAX_DEPTH} levels. A schema the
 * subset cannot express (recursion, maps, too deep) is a programming error:
 * `RangeError`.
 */
export function llmJsonSchema(schema: z.ZodType): LlmJsonSchema {
  const converted = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' });
  const defs = isNode(converted['$defs']) ? converted['$defs'] : {};
  const rest = inline(converted, defs, []) as JsonSchemaNode;
  delete rest['$schema'];
  const wrapped = rest['type'] !== 'object' || !isNode(rest['properties']);
  const source: JsonSchemaNode = wrapped
    ? { type: 'object', properties: { result: rest }, required: ['result'] }
    : rest;
  return { schema: strict(source, 1), source, wrapped };
}

/** Whether `value` fits the `const` keys of an object branch (discriminated unions). */
function branchFits(branch: JsonSchemaNode, value: Record<string, unknown>): boolean {
  const properties = branch['properties'];
  if (!isNode(properties)) return false;
  return Object.entries(properties).every(
    ([key, child]) => !isNode(child) || !('const' in child) || child['const'] === value[key],
  );
}

/**
 * Reverses "optional → required + null" on an answer before zod reads it:
 * a `null` under a key the zod schema made optional is removed (walking
 * `source`; for a union, the first object branch whose `const` keys match).
 */
export function dropNullOptionals(value: unknown, source: JsonSchemaNode): unknown {
  if (Array.isArray(value)) {
    const prefix = source['prefixItems'];
    return value.map((item: unknown, index) => {
      const itemSchema: unknown = Array.isArray(prefix)
        ? (prefix as unknown[])[index]
        : source['items'];
      return isNode(itemSchema) ? dropNullOptionals(item, itemSchema) : item;
    });
  }
  if (!isNode(value)) return value;
  const branches = source['anyOf'] ?? source['oneOf'];
  if (Array.isArray(branches)) {
    const branch = (branches as unknown[]).find((item) => isNode(item) && branchFits(item, value));
    return isNode(branch) ? dropNullOptionals(value, branch) : value;
  }
  const properties = source['properties'];
  if (!isNode(properties)) return value;
  const required = Array.isArray(source['required']) ? source['required'] : [];
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null && !required.includes(key) && key in properties) continue;
    const child = properties[key];
    out[key] = isNode(child) ? dropNullOptionals(item, child) : item;
  }
  return out;
}
