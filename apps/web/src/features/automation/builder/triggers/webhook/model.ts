import type {
  AutomationValue,
  IncomingWebhookSample,
  ValuePathSegment,
  WebhookTriggerPart,
} from '@cellhive/contracts';

/**
 * The `webhook.received` trigger in the builder (BACKLOG T612, CONTRACTS
 * §21 "Trigger webhook", §25.3): the captured sample as a tree of paths, the
 * values and template references a path becomes, and the state of a
 * "listen for a sample request" window. Pure, table-driven tests.
 *
 * Constants of `@cellhive/contracts` are copied here, pinned by a test:
 * importing them would grow the contracts chunk of the app shell (T614).
 */

/** `INCOMING_WEBHOOK_LISTEN_SECONDS` (CONTRACTS §25.6). */
export const LISTEN_SECONDS = 180;
/** `MAX_VALUE_PATH_LENGTH` (CONTRACTS §21). */
export const MAX_PATH_LENGTH = 500;
/** `WEBHOOK_TRIGGER_PARTS`, in the order shown. */
export const WEBHOOK_PARTS: readonly WebhookTriggerPart[] = ['body', 'headers', 'query'];

/** Array items shown per array (the rest is summarized as "N more"). */
export const MAX_ARRAY_ITEMS = 20;
/** Nodes built per tree: a 64 KB body can hold thousands. */
export const MAX_TREE_NODES = 1000;
/** Paths offered in the "+" menu besides the three whole parts. */
export const MAX_PICKER_PATHS = 200;
/** Longest preview of a string value. */
const PREVIEW_LENGTH = 60;

export type SampleNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface SampleNode {
  /** Unique in the tree: the part and the path (`body`, `body.customer.email`). */
  readonly id: string;
  readonly part: WebhookTriggerPart;
  /** The key (object), the index (array) or `null` for the part itself. */
  readonly key: string | number | null;
  readonly path: readonly ValuePathSegment[];
  /** The path as stored in a value (`customer.email`, `items[0].sku`); `''` for the part. */
  readonly pathText: string;
  readonly kind: SampleNodeKind;
  /** Short text of a scalar (strings quoted, cut at 60 characters). */
  readonly preview: string | null;
  /** Number of keys / items of an object / array (all of them, shown or not). */
  readonly size: number;
  readonly children: readonly SampleNode[];
  /** Items of the array not shown (over {@link MAX_ARRAY_ITEMS}, or the node cap). */
  readonly hidden: number;
  /**
   * Whether a value or a reference can name it: a key with `.`, `[`, `]` (or
   * empty) cannot be written in a path (CONTRACTS §21), nor a path over 500.
   */
  readonly pickable: boolean;
  /** The body, over 64 KB: kept as its first 64 KB of text, no path inside (T603). */
  readonly truncated: boolean;
}

/** Whether `key` can be one step of a value path (`parseValuePath` reads it back). */
export function isPathKey(key: string): boolean {
  return key !== '' && !/[.[\]]/u.test(key);
}

/**
 * A path as text (`customer.email`, `items[0].sku`, `[0]`), the inverse of
 * `parseValuePath`; `null` when a key cannot be written (see {@link isPathKey}).
 */
export function formatValuePath(path: readonly ValuePathSegment[]): string | null {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${String(segment)}]`;
      continue;
    }
    if (!isPathKey(segment)) return null;
    out += out === '' ? segment : `.${segment}`;
  }
  return out;
}

/** `body`, `body.customer.email`, `body[0].sku`: how a path is named to people. */
export function displayPath(part: WebhookTriggerPart, pathText: string): string {
  if (pathText === '') return part;
  return pathText.startsWith('[') ? `${part}${pathText}` : `${part}.${pathText}`;
}

function kindOf(value: unknown): SampleNodeKind {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

function previewOf(value: unknown, kind: SampleNodeKind): string | null {
  switch (kind) {
    case 'string': {
      const text = String(value);
      const cut = text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
      return JSON.stringify(cut);
    }
    case 'number':
    case 'boolean':
      return String(value);
    case 'null':
      return 'null';
    default:
      return null;
  }
}

/**
 * The tree of one part of the sample. `budget` counts the nodes left
 * (shared by the three parts); a node past it is not built and counted
 * in its parent's `hidden`.
 */
function buildNode(
  part: WebhookTriggerPart,
  value: unknown,
  key: string | number | null,
  path: readonly ValuePathSegment[],
  parentPickable: boolean,
  budget: { left: number },
): SampleNode {
  budget.left -= 1;
  const kind = kindOf(value);
  const pathText = formatValuePath(path);
  const pickable =
    parentPickable && pathText !== null && pathText.length <= MAX_PATH_LENGTH && path.length <= 64;
  const text = pathText ?? path.map(String).join('.');
  const children: SampleNode[] = [];
  let size = 0;
  let hidden = 0;
  if (kind === 'object' || kind === 'array') {
    const entries: [string | number, unknown][] =
      kind === 'array'
        ? (value as unknown[]).map((item, index) => [index, item])
        : Object.entries(value as Record<string, unknown>);
    size = entries.length;
    entries.forEach(([childKey, child], index) => {
      if ((kind === 'array' && index >= MAX_ARRAY_ITEMS) || budget.left <= 0) {
        hidden += 1;
        return;
      }
      children.push(buildNode(part, child, childKey, [...path, childKey], pickable, budget));
    });
  }
  return {
    id: displayPath(part, text),
    part,
    key,
    path,
    pathText: text,
    kind,
    preview: previewOf(value, kind),
    size,
    children,
    hidden,
    pickable,
    truncated: false,
  };
}

/** The three parts of a sample as trees (body, headers, query), in that order. */
export function sampleTree(sample: IncomingWebhookSample): SampleNode[] {
  const budget = { left: MAX_TREE_NODES };
  return WEBHOOK_PARTS.map((part) => {
    if (part === 'body' && sample.truncated) {
      // A string of the first 64 KB: the whole body only (it is read in full when a run reads it).
      budget.left -= 1;
      return {
        id: part,
        part,
        key: null,
        path: [],
        pathText: '',
        kind: 'string',
        preview: null,
        size: typeof sample.body === 'string' ? sample.body.length : 0,
        children: [],
        hidden: 0,
        pickable: true,
        truncated: true,
      } satisfies SampleNode;
    }
    const value = part === 'body' ? sample.body : sample[part];
    return buildNode(part, value, null, [], true, budget);
  });
}

/** Every node of the trees, depth first. */
export function flattenTree(nodes: readonly SampleNode[]): SampleNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/**
 * A template reference to webhook data (CONTRACTS §21): `[@body]`,
 * `[@body.customer.email]`, `[@body.items[0\].sku]` — `]` and `\` of the id
 * escaped inside the brackets, as the server stores it.
 */
export function webhookReferenceExpression(part: WebhookTriggerPart, pathText: string): string {
  const id = `@${displayPath(part, pathText)}`;
  return `[${id.replace(/[\\\]]/gu, (char) => `\\${char}`)}]`;
}

/** The whole value of a path: `{ "trigger": "body", "path": "customer.email" }`. */
export function webhookValue(part: WebhookTriggerPart, pathText: string): AutomationValue {
  return pathText === '' ? { trigger: part } : { trigger: part, path: pathText };
}

/** Path of the text after the part: `.a.b` → `a.b`, `[0].a` → `[0].a`; `null` when malformed. */
function pathAfterPart(rest: string): string | null {
  if (rest === '') return '';
  const text = rest.startsWith('.') ? rest.slice(1) : rest.startsWith('[') ? rest : null;
  if (text === null || text === '' || text.length > MAX_PATH_LENGTH) return null;
  // Keys, `.` between them, `[n]` (the syntax of `parseValuePath`).
  return /^(?:[^.[\]]+|\[\d{1,9}\])(?:\.[^.[\]]+|\[\d{1,9}\])*$/u.test(text) ? text : null;
}

/**
 * The webhook data a placeholder refers to, when it is one plain reference
 * (`[@body.customer.email]`): its part and path text; `null` otherwise.
 */
export function webhookReferenceOf(
  expression: string,
): { readonly part: WebhookTriggerPart; readonly pathText: string } | null {
  const source = expression.trim();
  if (!source.startsWith('[@') || !source.endsWith(']')) return null;
  let id = '';
  for (let index = 1; index < source.length - 1; index += 1) {
    const char = source.charAt(index);
    if (char === '\\') {
      index += 1;
      id += source.charAt(index);
    } else if (char === ']') {
      // An unescaped `]` closes the reference early: more than one (`[@body].[x]`).
      return null;
    } else {
      id += char;
    }
  }
  const match = /^@(body|headers|query)(.*)$/su.exec(id);
  if (match === null) return null;
  const pathText = pathAfterPart(match[2] ?? '');
  return pathText === null ? null : { part: match[1] as WebhookTriggerPart, pathText };
}

/** What the "+" menu offers for webhook data: the whole parts, then the sample's paths. */
export interface WebhookPathItem {
  readonly part: WebhookTriggerPart;
  readonly pathText: string;
  /** `body.customer.email`. */
  readonly label: string;
  readonly kind: SampleNodeKind | null;
  readonly preview: string | null;
}

/**
 * Items of the "Webhook data" section: `body`, `headers`, `query` always
 * (no sample needed), then every pickable path of the sample (at most 200;
 * none inside a truncated body — T603).
 */
export function webhookPathItems(sample: IncomingWebhookSample | null): WebhookPathItem[] {
  const whole: WebhookPathItem[] = WEBHOOK_PARTS.map((part) => ({
    part,
    pathText: '',
    label: part,
    kind: null,
    preview: null,
  }));
  if (sample === null) return whole;
  const paths = flattenTree(sampleTree(sample))
    .filter((node) => node.key !== null && node.pickable)
    .slice(0, MAX_PICKER_PATHS)
    .map((node) => ({
      part: node.part,
      pathText: node.pathText,
      label: node.id,
      kind: node.kind,
      preview: node.preview,
    }));
  return [...whole, ...paths];
}

/** A preview short enough for the hint column of the "+" menu (24 characters). */
export function shortPreview(preview: string | null): string | undefined {
  if (preview === null) return undefined;
  return preview.length > 24 ? `${preview.slice(0, 23)}…` : preview;
}

/** State of the "listen for a sample request" panel. */
export type ListenState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'listening'; readonly secondsLeft: number }
  | { readonly kind: 'captured'; readonly receivedAt: string }
  | { readonly kind: 'expired' };

/**
 * Where the window stands: `deadline` is when it closes (ms; `null` when not
 * listening), `startedHere` whether this screen opened it (an expired window
 * says so only then). A captured sample wins once the window closed.
 */
export function listenState(input: {
  readonly sample: IncomingWebhookSample | null;
  readonly deadline: number | null;
  readonly startedHere: boolean;
  readonly now: number;
}): ListenState {
  const { sample, deadline, startedHere, now } = input;
  if (deadline !== null && deadline > now) {
    return { kind: 'listening', secondsLeft: Math.ceil((deadline - now) / 1000) };
  }
  if (sample !== null) return { kind: 'captured', receivedAt: sample.received_at };
  if (deadline !== null && startedHere) return { kind: 'expired' };
  return { kind: 'idle' };
}

/** `2:05` — minutes and seconds left. */
export function countdownText(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60))}:${String(safe % 60).padStart(2, '0')}`;
}
