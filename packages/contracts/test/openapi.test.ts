import { readFile } from 'node:fs/promises';

import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';

import { problemDetailsSchema } from '../src/errors.js';
import { generateOpenApiDocument, serializeOpenApiDocument } from '../src/openapi/index.js';
import { SAVE_ERROR_EXAMPLE } from '../src/openapi/routes/email-identities.js';

import type { OpenAPI } from 'openapi-types';

/** `POST` routes that read (CONTRACTS §1.1): no `Idempotency-Key`. */
const READ_POSTS = new Set([
  '/api/v1/tables/{tableId}/records/query',
  '/api/v1/tables/{tableId}/records/group-counts',
  '/api/v1/tables/{tableId}/records/tree',
  '/api/v1/tables/{tableId}/records/summaries',
  '/api/v1/fields/{fieldId}/link-candidates',
  '/api/v1/widgets/{widgetId}/data',
  '/api/v1/widgets/{widgetId}/options',
  '/api/v1/widgets/{widgetId}/records',
  // Streamed multipart upload: `Idempotency-Key` is ignored (CONTRACTS §1.1, §19).
  '/api/v1/bases/{baseId}/imports/uploads',
  // Not bound to an organization; a retry only starts a new link attempt (CONTRACTS §1.1, §27.3).
  '/api/v1/me/identities/{provider}/start',
]);

describe('OpenAPI generation', () => {
  it('produces a valid OpenAPI 3.1 document', async () => {
    const document = generateOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    // validate() dereferences in place, so give it a copy.
    const copy = JSON.parse(serializeOpenApiDocument(document)) as OpenAPI.Document;
    await expect(SwaggerParser.validate(copy)).resolves.toBeDefined();
    // Generating and validating the whole document takes ~6 s on a CI runner that also
    // runs coverage; the default 5 s timeout made it flaky.
  }, 30_000);

  it('registers the problem+json component, /healthz and /readyz', () => {
    const document = generateOpenApiDocument();
    expect(document.components?.schemas).toHaveProperty('ProblemDetails');
    expect(document.components?.schemas).toHaveProperty('ErrorCode');
    expect(document.paths).toHaveProperty('/healthz');
    expect(document.paths).toHaveProperty('/readyz');
    expect(document.components?.schemas).toHaveProperty('ReadinessStatus');
  });

  it('publishes the options of link, parent, formula and lookup fields (T471)', () => {
    const schemas = generateOpenApiDocument().components?.schemas ?? {};
    for (const name of [
      'LinkFieldOptions',
      'ParentFieldOptions',
      'FormulaFieldOptions',
      'LookupFieldOptions',
    ]) {
      expect(schemas, name).toHaveProperty(name);
      expect(JSON.stringify(schemas['FieldOptions'])).toContain(name);
    }
  });

  it('serializes deterministically with sorted keys and a trailing newline', () => {
    const first = serializeOpenApiDocument(generateOpenApiDocument());
    const second = serializeOpenApiDocument(generateOpenApiDocument());
    expect(second).toBe(first);
    expect(first.endsWith('}\n')).toBe(true);
    expect(serializeOpenApiDocument({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 0 } })).toBe(
      '{\n  "a": {\n    "c": 0,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('matches the committed openapi.json (run `pnpm gen:openapi` after changing contracts)', async () => {
    const committed = await readFile(new URL('../openapi.json', import.meta.url), 'utf8');
    expect(serializeOpenApiDocument(generateOpenApiDocument())).toBe(committed);
  });

  it('documents the display name rule of sender identities with an example (T540)', () => {
    expect(problemDetailsSchema.parse(SAVE_ERROR_EXAMPLE)).toEqual(SAVE_ERROR_EXAMPLE);
    const document = generateOpenApiDocument();
    const paths = document.paths as Record<string, Record<string, unknown>>;
    for (const [path, method] of [
      ['/api/v1/orgs/{orgId}/email-identities', 'post'],
      ['/api/v1/email-identities/{identityId}', 'patch'],
    ] as const) {
      const operation = paths[path]?.[method] as {
        responses: Record<string, { description: string; content: Record<string, object> }>;
      };
      const unprocessable = operation.responses['422'];
      expect(unprocessable?.description).toContain('DISPLAY_NAME_NOT_ALLOWED');
      expect(unprocessable?.content['application/problem+json']).toMatchObject({
        example: SAVE_ERROR_EXAMPLE,
      });
    }
    const identity = document.components?.schemas?.['EmailIdentity'] as {
      properties: Record<string, object>;
      required: string[];
    };
    expect(identity.properties).toHaveProperty('display_name_issue');
    expect(identity.required).toContain('display_name_issue');
  });

  it('declares Idempotency-Key on every authenticated write POST (CONTRACTS §1.1)', () => {
    const document = generateOpenApiDocument();
    const missing: string[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      const post = (item as Record<string, unknown>).post as
        { security?: object[]; parameters?: { in: string; name: string }[] } | undefined;
      if (post === undefined) continue;
      // Public routes allow an anonymous caller (no or an empty security requirement).
      const security = post.security ?? [];
      const isPublic =
        security.length === 0 || security.some((entry) => Object.keys(entry).length === 0);
      if (isPublic || READ_POSTS.has(path)) continue;
      const headers = (post.parameters ?? []).filter((parameter) => parameter.in === 'header');
      if (!headers.some((parameter) => parameter.name === 'idempotency-key')) missing.push(path);
    }
    expect(missing).toEqual([]);
  });
});
