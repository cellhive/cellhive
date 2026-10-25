import { define, sig, ex } from '../catalogue/define.js';

import type { FunctionImpl } from '../evaluate/runtime.js';

/** RECORD_ID (SPEC §9.3, logic). */
export const RECORD_ID = define({
  name: 'RECORD_ID',
  group: 'logic',
  signatures: [sig('text', [])],
  result: (ctx) => ({ kind: 'text', recordIdOf: ctx.tableId }),
  description: { en: 'The ID of the current record.', vi: 'ID của record hiện tại.' },
  examples: [ex('RECORD_ID()', 'rec_8Hk2VbQx3LmN9pRt')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => args.rt.row.id;
