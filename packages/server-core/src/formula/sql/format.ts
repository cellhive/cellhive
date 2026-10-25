import { sql } from 'kysely';

import { texts, txt } from '../call.js';

import type { SqlFunction } from '../call.js';

/** FORMAT (SPEC §9.3): Placeholders {1}, {2}, … filled with the values (`fx.format`). */
export const FORMAT: SqlFunction = (call) => sql`fx.format(${txt(call, 0)}, ${texts(call, 1)})`;
