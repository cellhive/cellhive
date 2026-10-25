import { sql } from 'kysely';

import type { SqlFunction } from '../call.js';

/** TODAY (SPEC §9.3): Today in the zone (ADR-21 §3). */
export const TODAY: SqlFunction = (call) =>
  sql`fx.local_date(${call.compiler.now()}, ${call.compiler.tz()})`;
