import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** ENCODEURL (SPEC §9.3): Percent-encoding like encodeURIComponent (`fx.encodeurl`). */
export const ENCODEURL: SqlFunction = (call) => sql`fx.encodeurl(${txt(call, 0)})`;
