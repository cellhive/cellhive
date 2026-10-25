import { generateOpenApiDocument, serializeOpenApiDocument } from '@cellhive/contracts/openapi';
import { Controller, Get, Header } from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';

/**
 * `GET /api/v1/openapi.json` (SPEC §13.1): the OpenAPI 3.1 document
 * generated from the zod contracts, the same one `pnpm gen:openapi` writes.
 * Public (it describes the API, it holds no data); built once per process.
 */
@Controller()
@Public({ ignoreSession: true })
export class OpenApiController {
  private document: string | undefined;

  @Get('openapi.json')
  @Header('content-type', 'application/json; charset=utf-8')
  @Header('cache-control', 'public, max-age=300')
  openapi(): string {
    this.document ??= serializeOpenApiDocument(generateOpenApiDocument());
    return this.document;
  }
}
