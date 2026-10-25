import { PROBLEM_CONTENT_TYPE, type problemDetailsSchema } from '../errors.js';

import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/** Schemas shared by every route, registered once per document. */
export interface CommonComponents {
  problemDetails: typeof problemDetailsSchema;
}

/** Registers one feature's routes. Each API module contributes one and adds it to `routes.ts`. */
export type RouteRegistrar = (registry: OpenAPIRegistry, components: CommonComponents) => void;

/** A `responses` entry for an error status, rendered as `application/problem+json`. */
export function problemResponse(components: CommonComponents, description: string) {
  return {
    description,
    content: { [PROBLEM_CONTENT_TYPE]: { schema: components.problemDetails } },
  };
}
