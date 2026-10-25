import { Buffer } from 'node:buffer';

import {
  HTTP_DELIVERY_REQUEST_BODY_MAX_BYTES,
  HTTP_REQUEST_MAX_HEADER_VALUE_LENGTH,
  type AutomationTextContext,
  type AutomationValue,
  type HttpRequestConfig,
} from '@cellhive/contracts';

import { AutomationStepError } from '../../engine/errors.js';
import { escapeHeader, truncateText } from '../../values/escape.js';

import type { HttpDeliveryWait } from '../../engine/http-wait.js';
import type { AutomationValueEvaluator, TemplateWarning } from '../../values/evaluator.js';

/** What an `http_request` renders to: the request for the outbox, and the render warnings. */
export interface RenderedHttpRequest {
  readonly delivery: HttpDeliveryWait;
  readonly warnings: readonly TemplateWarning[];
}

/** Default `Content-Type` per body type (a `Content-Type` header of the action wins). */
const CONTENT_TYPES = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  text: 'text/plain; charset=utf-8',
} as const;

/**
 * Text of a resolved value: a string as is, `null` as "", a list of one
 * scalar as that scalar (a lookup of one record), any other JSON value as
 * JSON text.
 */
export function httpValueText(value: unknown): string {
  let current = value;
  if (Array.isArray(current) && current.length === 1) {
    const [only] = current as unknown[];
    if (only === null || typeof only !== 'object') current = only;
  }
  if (current === null || current === undefined) return '';
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  return JSON.stringify(current);
}

/**
 * Renders the request of an `http_request` step (SPEC §11.5, CONTRACTS
 * §21; BACKLOG T606) with the evaluator's person — `run_as` when the step
 * runs, the caller for "Send a test":
 *
 * - **URL**: a template with each placeholder value percent-encoded
 *   (`url_component`: a record value can never add a path segment, a query
 *   or a fragment); a literal/field/step/trigger value as the whole URL;
 *   then `query` appended (encoded). Not a URL → `ssrf_blocked`
 *   (`invalid_url`); the outbox checks scheme, user info and length again.
 * - **Headers**: one line each (`header`: CR/LF and controls become
 *   spaces), cut at 8,192 characters, characters outside printable ASCII
 *   percent-encoded as UTF-8 (HTTP header values carry no other text); the
 *   `Content-Type` of the body unless a header sets it.
 * - **Body**: `json` — a literal as its JSON, a template rendered with its
 *   values escaped as JSON string content (`json_string`) that must then
 *   parse (`invalid_value`, `reason: invalid_json`), another value as its
 *   JSON; `form` — `application/x-www-form-urlencoded` of the fields as
 *   text; `text` — the value as text (`plain`; a `digest` too). Larger than
 *   1 MiB → `http_request_too_large`.
 *
 * Secret values are not read here: the request names the secrets by id and
 * the outbox reads them at each attempt.
 */
export async function renderHttpRequest(
  values: Pick<AutomationValueEvaluator, 'resolve'>,
  config: HttpRequestConfig,
): Promise<RenderedHttpRequest> {
  const warnings: TemplateWarning[] = [];
  const text = async (value: AutomationValue, context: AutomationTextContext): Promise<string> => {
    const resolved = await values.resolve(value, { context });
    warnings.push(...resolved.warnings);
    return httpValueText(resolved.value);
  };

  // --- URL and query.
  const urlText = (await text(config.url, 'url_component')).trim();
  let url = urlText;
  if (config.query.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(urlText);
    } catch {
      throw new AutomationStepError('ssrf_blocked', 'The URL is not valid.', {
        params: { reason: 'invalid_url' },
      });
    }
    for (const item of config.query) {
      parsed.searchParams.append(item.name, await text(item.value, 'plain'));
    }
    url = parsed.href;
  }

  // --- Headers.
  const headers: (readonly [string, string])[] = [];
  for (const item of config.headers) {
    const raw = await text(item.value, 'header');
    // A non-template value is not escaped by the evaluator: one line here too.
    const line = truncateText(escapeHeader(raw), HTTP_REQUEST_MAX_HEADER_VALUE_LENGTH).text;
    headers.push([item.name, asciiHeaderValue(line)]);
  }

  // --- Body.
  let body: string | null = null;
  const spec = config.body;
  if (spec !== null) {
    if (spec.type === 'json') {
      if ('literal' in spec.value) {
        body = JSON.stringify(spec.value.literal);
      } else if ('template' in spec.value) {
        body = await text(spec.value, 'json_string');
        try {
          JSON.parse(body);
        } catch {
          throw new AutomationStepError('invalid_value', 'The JSON body does not parse.', {
            params: { field: 'body', reason: 'invalid_json' },
          });
        }
      } else {
        const resolved = await values.resolve(spec.value);
        warnings.push(...resolved.warnings);
        body = JSON.stringify(resolved.value ?? null);
      }
    } else if (spec.type === 'form') {
      const form = new URLSearchParams();
      for (const item of spec.fields) form.append(item.name, await text(item.value, 'plain'));
      body = form.toString();
    } else {
      body = await text(spec.value, 'plain');
    }
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > HTTP_DELIVERY_REQUEST_BODY_MAX_BYTES) {
      throw new AutomationStepError('http_request_too_large', 'The request body is too large.', {
        params: { limit_bytes: HTTP_DELIVERY_REQUEST_BODY_MAX_BYTES, size_bytes: bytes },
      });
    }
    if (!headers.some(([name]) => name.toLowerCase() === 'content-type')) {
      headers.push(['Content-Type', CONTENT_TYPES[spec.type]]);
    }
  }

  return {
    delivery: {
      request: {
        method: config.method,
        url,
        headers,
        body,
        authHeaderName: config.auth?.header_name ?? null,
        failOnHttpError: config.fail_on_http_error,
      },
      authSecretId: config.auth?.secret_id ?? null,
      signingSecretId: config.signing_secret_id,
    },
    warnings: dedupeWarnings(warnings),
  };
}

/** Characters outside printable ASCII as `%XX` of their UTF-8 bytes (`Đơn` → `%C4%90%C6%A1n`). */
export function asciiHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/gu, (char) => encodeURIComponent(char));
}

function dedupeWarnings(warnings: readonly TemplateWarning[]): TemplateWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = JSON.stringify(warning);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
