import type { Phase2FunctionDefinition } from './types.js';

const trig = (name: string, syntax: string, en: string, vi: string): Phase2FunctionDefinition => ({
  name,
  group: 'number',
  syntax,
  description: { en, vi },
  phase2: true,
  volatile: false,
});

/**
 * Phase 2 functions (SPEC §9.3): shown in the catalogue as "not supported
 * yet"; the parser rejects them with `UNSUPPORTED_FUNCTION`.
 */
export const PHASE2_FUNCTIONS: readonly Phase2FunctionDefinition[] = [
  {
    name: 'RANDOMBETWEEN',
    group: 'number',
    syntax: 'RANDOMBETWEEN(bottom, top, [update_continuously])',
    description: {
      en: 'A random integer between two numbers.',
      vi: 'Một số nguyên ngẫu nhiên giữa hai số.',
    },
    phase2: true,
    volatile: true,
  },
  {
    name: 'RANDOMITEM',
    group: 'list',
    syntax: 'RANDOMITEM(list, [update_continuously])',
    description: {
      en: 'A random element of a list.',
      vi: 'Một phần tử ngẫu nhiên của danh sách.',
    },
    phase2: true,
    volatile: true,
  },
  {
    name: 'SEQUENCE',
    group: 'list',
    syntax: 'SEQUENCE(start, end, [step])',
    description: {
      en: 'A list of numbers from start to end by step.',
      vi: 'Danh sách số từ start tới end theo bước step.',
    },
    phase2: true,
    volatile: false,
  },
  {
    name: 'REGEXEXTRACTALL',
    group: 'text',
    syntax: 'REGEXEXTRACTALL(text, pattern)',
    description: {
      en: 'Every part of a text that matches a regular expression.',
      vi: 'Mọi phần của chuỗi khớp biểu thức chính quy.',
    },
    phase2: true,
    volatile: false,
  },
  {
    name: 'DISTANCE',
    group: 'geo',
    syntax: 'DISTANCE(location1, location2)',
    description: {
      en: 'Distance between two locations (needs the location field, Phase 2).',
      vi: 'Khoảng cách giữa hai vị trí (cần field vị trí, Phase 2).',
    },
    phase2: true,
    volatile: false,
  },
  trig('SIN', 'SIN(angle)', 'Sine of an angle in radians.', 'Sin của góc (radian).'),
  trig('COS', 'COS(angle)', 'Cosine of an angle in radians.', 'Cos của góc (radian).'),
  trig('TAN', 'TAN(angle)', 'Tangent of an angle in radians.', 'Tan của góc (radian).'),
  trig('COT', 'COT(angle)', 'Cotangent of an angle in radians.', 'Cotan của góc (radian).'),
  trig('ASIN', 'ASIN(number)', 'Arcsine, in radians.', 'Arcsin, tính bằng radian.'),
  trig('ACOS', 'ACOS(number)', 'Arccosine, in radians.', 'Arccos, tính bằng radian.'),
  trig('ATAN', 'ATAN(number)', 'Arctangent, in radians.', 'Arctan, tính bằng radian.'),
  trig(
    'ATAN2',
    'ATAN2(x, y)',
    'Angle of the point (x, y), in radians.',
    'Góc của điểm (x, y), tính bằng radian.',
  ),
  trig('SINH', 'SINH(number)', 'Hyperbolic sine.', 'Sin hyperbol.'),
  trig('COSH', 'COSH(number)', 'Hyperbolic cosine.', 'Cos hyperbol.'),
  trig('TANH', 'TANH(number)', 'Hyperbolic tangent.', 'Tan hyperbol.'),
  trig('DEGREES', 'DEGREES(angle)', 'Converts radians to degrees.', 'Đổi radian sang độ.'),
  trig('RADIANS', 'RADIANS(angle)', 'Converts degrees to radians.', 'Đổi độ sang radian.'),
];
