import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** TODATE (SPEC §9.3): Datetime of a "YYYY-M-D[ H:mm[:ss]]" text in the zone; NULL otherwise (`fx.todate`). */
export const TODATE: SqlFunction = (call) => sql`fx.todate(${txt(call, 0)}, ${call.compiler.tz()})`;
