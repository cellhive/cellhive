import { sql } from 'kysely';

import { txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** UNACCENT (SPEC §9.3): Accents removed (`meta.f_unaccent`, the rules of the filter search). */
export const UNACCENT: SqlFunction = (call) => sql`meta.f_unaccent(${txt(call, 0)})`;
