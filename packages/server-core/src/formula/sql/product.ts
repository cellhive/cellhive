import { sql } from 'kysely';

import { numbers } from '../call.js';

import type { SqlFunction } from '../call.js';

/** PRODUCT (SPEC §9.3): Product of the numbers (`fx.product`; 0 when none). */
export const PRODUCT: SqlFunction = (call) => sql`fx.product(${numbers(call)})`;
