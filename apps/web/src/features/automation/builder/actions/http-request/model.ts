import {
  HTTP_HEADER_NAME_PATTERN,
  isAllowedHttpRequestHeader,
  parseValuePath,
  type AutomationAction,
  type AutomationValue,
  type HttpRequestBody,
  type HttpRequestConfig,
  type RunN8nWorkflowConfig,
} from '@cellhive/contracts';

import { escapeTemplateText, isEmptyValue, templateSegments } from '../../model/values';

import type { BuilderIssue, StepKey } from '../../model/issues';

/**
 * The pure part of the `http_request` / `run_n8n_workflow` editors (BACKLOG
 * T613, CONTRACTS §21, §25.5): what the builder can say before saving —
 * header names the outbox owns, URLs that can never be called, a JSON body
 * that will not parse — with the paths of the server's `422`, and the
 * response values a later step may read (`{ step, path }`).
 */

/** Longest URL the outbox calls (CONTRACTS §25.6). */
export const MAX_URL_LENGTH = 2_048;

/** Action types whose step is an HTTP call through the outbox. */
export const HTTP_STEP_TYPES: ReadonlySet<string> = new Set(['http_request', 'run_n8n_workflow']);

/** Client-only issue codes of these editors (translated in `automationBuilder:issues`). */
export const HTTP_CLIENT_ISSUE_CODES = [
  'URL_SCHEME_REQUIRED',
  'HEADER_NAME_INVALID',
  'INVALID_JSON',
  'GET_NO_BODY',
] as const;

/** Why a header name cannot be used, `null` when it can. */
export type HeaderNameProblem = 'required' | 'invalid' | 'forbidden' | 'duplicate';

/**
 * The problem of header `name` among the others of the step (the auth header
 * included — CONTRACTS §21: a name given twice is `HEADER_NOT_ALLOWED` too).
 */
export function headerNameProblem(
  name: string,
  others: readonly string[],
): HeaderNameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'required';
  if (!HTTP_HEADER_NAME_PATTERN.test(trimmed)) return 'invalid';
  if (!isAllowedHttpRequestHeader(trimmed)) return 'forbidden';
  const lower = trimmed.toLowerCase();
  if (others.some((other) => other.trim().toLowerCase() === lower)) return 'duplicate';
  return null;
}

/** Issue code of a header problem (the server's code where it has one). */
export function headerIssueCode(problem: HeaderNameProblem): string {
  switch (problem) {
    case 'required':
      return 'REQUIRED';
    case 'invalid':
      return 'HEADER_NAME_INVALID';
    case 'forbidden':
    case 'duplicate':
      return 'HEADER_NOT_ALLOWED';
  }
}

/**
 * Whether a literal URL can be called at all (`parseOutboundUrl` of the
 * server, CONTRACTS §25.4): `http`/`https`, a host, no user info, ≤ 2,048
 * characters. Private addresses and ports are checked when sending.
 */
export function isCallableUrl(text: string): boolean {
  const value = text.trim();
  if (value === '' || value.length > MAX_URL_LENGTH || /\s/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  return url.hostname !== '';
}

const SCHEME = /^https?:\/\/[^\s/?#{]/iu;

/**
 * Problem of a URL value, `null` when fine for now: empty → `REQUIRED`; a
 * literal that can never be called → `INVALID_URL`; a template whose typed
 * part does not start with `http(s)://` and a host → `URL_SCHEME_REQUIRED`
 * (each inserted value is percent-encoded — CONTRACTS §21 `url_component` —
 * so a value can never bring the scheme). A whole field/step value is the
 * URL itself: checked when the step runs.
 */
export function urlProblem(value: AutomationValue | undefined): string | null {
  if (value === undefined || isEmptyValue(value)) return 'REQUIRED';
  if ('literal' in value) {
    return typeof value.literal === 'string' && isCallableUrl(value.literal) ? null : 'INVALID_URL';
  }
  if ('template' in value) {
    const [first] = templateSegments(value.template);
    if (first?.kind !== 'text' || !SCHEME.test(first.text.trimStart())) {
      return 'URL_SCHEME_REQUIRED';
    }
    return null;
  }
  return null;
}

/** Where a JSON body template stops parsing, or `null` when it parses. */
export interface JsonProblem {
  /** 1-based character where parsing stopped, when the engine says (placeholders count as one). */
  readonly position: number | null;
}

/**
 * Whether a JSON body template parses once rendered (CONTRACTS §21: the
 * `json_string` context escapes each value as JSON string content, so a
 * placeholder renders as text inside quotes, or as a bare token such as a
 * number outside them). Each placeholder is replaced by `0`, which is valid
 * in both places, then the text is parsed.
 */
export function jsonTemplateProblem(template: string): JsonProblem | null {
  if (template.trim() === '') return null;
  const text = templateSegments(template)
    .map((segment) => (segment.kind === 'text' ? segment.text : '0'))
    .join('');
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    const match = /position (\d+)/u.exec(error instanceof Error ? error.message : '');
    return { position: match === null ? null : Number(match[1]) + 1 };
  }
}

/**
 * The JSON body value as the template field shows it: a template as is, a
 * literal JSON value (made through the API) as its pretty text.
 */
export function jsonBodyTemplate(value: AutomationValue): AutomationValue {
  if ('literal' in value) {
    const text =
      typeof value.literal === 'string' ? value.literal : JSON.stringify(value.literal, null, 2);
    return { template: escapeTemplateText(text) };
  }
  return value;
}

/**
 * A JSON body as stored: always a template, even without chips — a literal
 * string would be sent as one JSON string (CONTRACTS §21), not the object typed.
 */
export function jsonBodyValue(value: AutomationValue | undefined): AutomationValue {
  if (value === undefined) return { template: '' };
  if ('literal' in value && typeof value.literal === 'string') {
    return { template: escapeTemplateText(value.literal) };
  }
  return value;
}

/** A new `http_request` config: `POST` without a body yet, nothing else set. */
export function newHttpRequestConfig(): HttpRequestConfig {
  return {
    method: 'POST',
    url: { literal: '' },
    query: [],
    headers: [],
    auth: null,
    body: null,
    signing_secret_id: null,
    fail_on_http_error: true,
  };
}

/** A new `run_n8n_workflow` config: URL and signing secret to fill, every readable field. */
export function newRunN8nWorkflowConfig(): RunN8nWorkflowConfig {
  return {
    url: { literal: '' },
    signing_secret_id: '' as RunN8nWorkflowConfig['signing_secret_id'],
    fields: null,
    include_changes: true,
  };
}

/** A body of another type, keeping what can be kept. */
export function switchBodyType(
  body: HttpRequestBody | null,
  type: 'none' | HttpRequestBody['type'],
): HttpRequestBody | null {
  if (type === 'none') return null;
  if (body?.type === type) return body;
  switch (type) {
    case 'json':
      return { type, value: { template: '' } };
    case 'form':
      return { type, fields: [] };
    case 'text':
      return { type, value: { literal: '' } };
  }
}

/** An id still to choose (`''`), as `isUnset` of the draft (not imported: the draft imports this file). */
function unset(id: string | null | undefined): boolean {
  return id === undefined || id === null || id === '';
}

function issue(
  step: StepKey,
  path: string,
  code: string,
  params?: Record<string, unknown>,
): BuilderIssue {
  return { step, path, code, ...(params === undefined ? {} : { params }) };
}

/** The check before saving an `http_request` step (paths of the server's `422`). */
export function checkHttpRequest(step: StepKey, config: HttpRequestConfig): BuilderIssue[] {
  const out: BuilderIssue[] = [];
  const url = urlProblem(config.url);
  if (url !== null) out.push(issue(step, 'config.url', url));
  config.query.forEach((pair, index) => {
    if (pair.name.trim() === '') {
      out.push(issue(step, `config.query[${String(index)}].name`, 'REQUIRED'));
    }
  });
  const names = config.headers.map((header) => header.name);
  const authName = config.auth?.header_name;
  config.headers.forEach((header, index) => {
    const others = [...names.slice(0, index), ...(authName === undefined ? [] : [authName])];
    const problem = headerNameProblem(header.name, others);
    if (problem !== null) {
      out.push(issue(step, `config.headers[${String(index)}].name`, headerIssueCode(problem)));
    }
  });
  if (config.auth !== null) {
    const problem = headerNameProblem(config.auth.header_name, []);
    if (problem !== null) {
      out.push(issue(step, 'config.auth.header_name', headerIssueCode(problem)));
    }
    if (unset(config.auth.secret_id)) {
      out.push(issue(step, 'config.auth.secret_id', 'REQUIRED'));
    }
  }
  const body = config.body;
  if (body !== null) {
    if (config.method === 'GET') out.push(issue(step, 'config.body', 'GET_NO_BODY'));
    else if (body.type === 'json' && 'template' in body.value) {
      const problem = jsonTemplateProblem(body.value.template);
      if (body.value.template.trim() === '') {
        out.push(issue(step, 'config.body.value', 'REQUIRED'));
      } else if (problem !== null) {
        out.push(issue(step, 'config.body.value', 'INVALID_JSON'));
      }
    } else if (body.type === 'form') {
      body.fields.forEach((pair, index) => {
        if (pair.name.trim() === '') {
          out.push(issue(step, `config.body.fields[${String(index)}].name`, 'REQUIRED'));
        }
      });
    }
  }
  return out;
}

/** The check before saving a `run_n8n_workflow` step. */
export function checkRunN8nWorkflow(step: StepKey, config: RunN8nWorkflowConfig): BuilderIssue[] {
  const out: BuilderIssue[] = [];
  const url = urlProblem(config.url);
  if (url !== null) out.push(issue(step, 'config.url', url));
  if (unset(config.signing_secret_id)) {
    out.push(issue(step, 'config.signing_secret_id', 'REQUIRED'));
  }
  if (config.fields?.length === 0) out.push(issue(step, 'config.fields', 'REQUIRED'));
  return out;
}

// --- Response values for later steps --------------------------------------------------

/** Outputs of an HTTP step every later step may read (CONTRACTS §21 `HttpStepOutput`). */
export const HTTP_BASE_PATHS = ['status', 'body'] as const;

/** Most response paths listed from one test response. */
export const MAX_RESPONSE_PATHS = 50;
const MAX_DEPTH = 5;
const PLAIN_KEY = /^[^.[\]]+$/u;

/**
 * Paths of the values of a JSON response body (`body.id`,
 * `body.items[0].sku`), leaves first-found, the first item of each array,
 * at most 50. Keys a path cannot spell (with `.`, `[`, `]`) are skipped.
 */
export function responsePaths(body: unknown, max = MAX_RESPONSE_PATHS): string[] {
  const out: string[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (out.length >= max) return;
    if (Array.isArray(value)) {
      if (value.length === 0 || depth >= MAX_DEPTH) {
        out.push(path);
        return;
      }
      visit(value[0], `${path}[0]`, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).filter(([key]) =>
        PLAIN_KEY.test(key),
      );
      if (entries.length === 0 || depth >= MAX_DEPTH) {
        out.push(path);
        return;
      }
      for (const [key, item] of entries) visit(item, `${path}.${key}`, depth + 1);
      return;
    }
    out.push(path);
  };
  if (body !== null && typeof body === 'object') visit(body, 'body', 0);
  return out.filter((path) => path !== 'body');
}

/** The value at a response path, for its preview (`null` when missing). */
export function valueAtPath(response: { readonly body: unknown }, path: string): unknown {
  const parts = parseValuePath(path);
  if (parts === null) return null;
  let current: unknown = response;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current ?? null;
}

/**
 * Whether `path` may be offered as a response value: a valid value path
 * (SPEC §11.4) under `body`, or `status` / `headers.content-type`.
 */
export function isResponsePath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed === 'status' || trimmed === 'headers.content-type') return true;
  const parts = parseValuePath(trimmed);
  return parts !== null && parts[0] === 'body';
}

/** Every `{ step, path }` of `stepId` used anywhere in a value of the definition. */
export function usedStepPaths(definition: unknown, stepId: string): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record['step'] === stepId && typeof record['path'] === 'string') {
      out.push(record['path']);
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(definition);
  return out;
}

/**
 * The outputs of HTTP step `stepId` the "+" menu lists for later steps:
 * `status` and `body`, the paths already used in the definition, then the
 * ones the author picked (from a test response or typed), without repeats.
 */
export function httpStepPaths(
  definition: { readonly actions: readonly AutomationAction[] },
  stepId: string,
  picked: readonly string[] = [],
): string[] {
  return [
    ...new Set([...HTTP_BASE_PATHS, ...usedStepPaths(definition.actions, stepId), ...picked]),
  ];
}
