import { T } from '@cellhive/formula-engine';
import { sql } from 'kysely';

import { has, txt } from '../call.js';
import { nullOf } from '../values.js';

import type { SqlFunction } from '../call.js';

/** HYPERLINK (SPEC §9.3): Link text "[label](url)" or the bare url (`fx.hyperlink`). */
export const HYPERLINK: SqlFunction = (call) =>
  sql`fx.hyperlink(${txt(call, 0)}, ${has(call, 1) ? txt(call, 1) : nullOf(T.text)})`;
