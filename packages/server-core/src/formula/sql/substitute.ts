import { T } from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { has, num, txt } from '../call.js';
import { nullOf } from '../values.js';

import type { SqlFunction } from '../call.js';

/** SUBSTITUTE (SPEC §9.3): Replaces every occurrence, or only the n-th (`fx.substitute`). */
export const SUBSTITUTE: SqlFunction = (call) =>
  sql`fx.substitute(${txt(call, 0)}, ${txt(call, 1)}, ${txt(call, 2)}, ${
    has(call, 3) ? num(call, 3) : nullOf(T.number)
  })`;
