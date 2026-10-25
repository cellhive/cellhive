import type { SqlFunction } from '../call.js';

/** NOW (SPEC §9.3): The current instant (volatile: virtual fields only). */
export const NOW: SqlFunction = (call) => call.compiler.now();
