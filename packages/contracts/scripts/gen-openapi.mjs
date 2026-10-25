// @ts-check
// Writes packages/contracts/openapi.json from the built route registry.
// Run through `pnpm gen:openapi`, which builds the package first.
import { writeFile } from 'node:fs/promises';

import { generateOpenApiDocument, serializeOpenApiDocument } from '../dist/openapi/index.js';

const target = new URL('../openapi.json', import.meta.url);
await writeFile(target, serializeOpenApiDocument(generateOpenApiDocument()), 'utf8');
