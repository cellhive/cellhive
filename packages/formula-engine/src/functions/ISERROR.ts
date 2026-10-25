import { define, p, sig, ex, fixed } from '../catalogue/define.js';
import { isNull } from '../evaluate/values.js';
import { T } from '../types/formula-type.js';

import type { Expr, Reference } from '../ast.js';
import type { FunctionImpl } from '../evaluate/runtime.js';

/** ISERROR (SPEC §9.3, logic). */
export const ISERROR = define({
  name: 'ISERROR',
  group: 'logic',
  signatures: [sig('boolean', [p('value', 'value')])],
  result: fixed(T.boolean),
  description: {
    en: 'True when the value is an error (for example a division by zero).',
    vi: 'Đúng khi giá trị bị lỗi (ví dụ chia cho 0).',
  },
  notes: {
    en: 'A value is an error when it is empty although none of its inputs is empty.',
    vi: 'Giá trị bị coi là lỗi khi nó rỗng trong khi mọi đầu vào đều không rỗng.',
  },
  examples: [ex('ISERROR(1 / 0)', 'TRUE')],
});

/** TS evaluation (T453, SPEC §9.4). */
export const implementation: FunctionImpl = (args) => {
  // Empty although every [Field] it reads has a value (SPEC §9.4).
  if (!isNull(args.value(0))) return false;
  return fieldReferences(args.node(0)).every((reference) => args.evaluate(reference) !== null);
};

/** `[Field]` references an expression reads (the inputs of ISERROR). */
function fieldReferences(node: Expr): Reference[] {
  switch (node.type) {
    case 'reference':
      return node.kind === 'field' ? [node] : [];
    case 'member':
      return fieldReferences(node.object);
    case 'call':
      return node.args.flatMap(fieldReferences);
    case 'let':
      return [
        ...node.bindings.flatMap((binding) => fieldReferences(binding.value)),
        ...fieldReferences(node.body),
      ];
    case 'unary':
      return fieldReferences(node.operand);
    case 'binary':
      return [...fieldReferences(node.left), ...fieldReferences(node.right)];
    default:
      return [];
  }
}
