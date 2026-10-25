import { argsFrom, elementOfType } from '../call.js';

import type { SqlFunction } from '../call.js';

/** LISTCOMBINE (SPEC §9.3): Values and lists combined into one flat list. */
export const LISTCOMBINE: SqlFunction = (call) =>
  call.compiler.combine(argsFrom(call, 0), elementOfType(call.type));
