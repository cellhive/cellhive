/**
 * Fixture of the filter equivalence harness (SPEC §6.3, BACKLOG T105): one
 * data table with a column per S1 field type/style, ≥ 300 records with the
 * awkward values (diacritics, `đ`, LIKE metacharacters, quotes, NULL vs
 * empty, decimals beyond double precision, DST boundaries) and a pool of
 * operands per field group from which every type × operator case is derived.
 */
import { FIELD_TYPE_REGISTRY, type S1FieldType } from '@cellhive/field-types';
import {
  allowedOperators,
  fieldProfile,
  RELATIVE_DATES,
  RELATIVE_DATES_WITH_AMOUNT,
  type DslOperator,
  type FilterNode,
  type FilterOperand,
  type FilterValue,
} from '@cellhive/filter-dsl';

import type { SqlFilterFieldMeta, SqlFilterTableMeta } from '../../src/query/index.js';
import type { Id, IdPrefix } from '@cellhive/contracts';

export function fixedId<P extends IdPrefix>(prefix: P, name: string): Id<P> {
  return `${prefix}_${name.padEnd(16, '0').slice(0, 16)}`;
}

/** Base collation of the fixture base (SPEC §5.5): Vietnamese ICU. */
export const COLLATION = 'vi-VN-x-icu';

export const opt = {
  new: fixedId('opt', 'new'),
  doing: fixedId('opt', 'doing'),
  done: fixedId('opt', 'done'),
  hold: fixedId('opt', 'hold'),
  a: fixedId('opt', 'tagA'),
  b: fixedId('opt', 'tagB'),
  c: fixedId('opt', 'tagC'),
  d: fixedId('opt', 'tagD'),
  e: fixedId('opt', 'tagE'),
} as const;

export const usr = {
  an: fixedId('usr', 'an'),
  binh: fixedId('usr', 'binh'),
  chi: fixedId('usr', 'chi'),
  dung: fixedId('usr', 'dung'),
  giang: fixedId('usr', 'giang'),
  /** Never stored anywhere. */
  ghost: fixedId('usr', 'ghost'),
} as const;

const STORED_USERS = [usr.an, usr.binh, usr.chi, usr.dung, usr.giang];
const STATUS = [opt.new, opt.doing, opt.done, opt.hold];
const TAGS = [opt.a, opt.b, opt.c, opt.d, opt.e];

const statusOptions = {
  multiple: false,
  options: [
    { id: opt.new, name: 'Mới' },
    { id: opt.doing, name: 'Đang xử lý' },
    { id: opt.done, name: 'Xong' },
    { id: opt.hold, name: 'Tạm dừng' },
  ],
};
const tagOptions = {
  multiple: true,
  options: TAGS.map((id, index) => ({ id, name: `Nhãn ${String(index + 1)}` })),
};

interface FixtureField extends SqlFilterFieldMeta {
  readonly id: Id<'fld'>;
  readonly type: S1FieldType;
}

const field = (name: string, type: S1FieldType, options: unknown = {}): FixtureField => ({
  id: fixedId('fld', name),
  name,
  type,
  options,
  dbColumnName:
    FIELD_TYPE_REGISTRY[type].systemColumn === null
      ? `f_${name.toLowerCase().padEnd(12, '0').slice(0, 12)}`
      : null,
});

export const fields = {
  title: field('title', 'text'),
  phone: field('phone', 'text', { style: { type: 'phone' } }),
  code: field('code', 'auto_number'),
  amount: field('amount', 'number', { style: { type: 'plain', precision: 2 } }),
  price: field('price', 'number', { style: { type: 'currency', currency_code: 'VND' } }),
  progress: field('progress', 'number', { style: { type: 'progress' } }),
  rating: field('rating', 'number', { style: { type: 'rating', max: 5 } }),
  due: field('due', 'datetime', { style: { format: 'dd/MM/yyyy' } }),
  dueNy: field('dueNy', 'datetime', {
    style: { format: 'MM/dd/yyyy HH:mm' },
    timezone: 'America/New_York',
  }),
  meetHcm: field('meetHcm', 'datetime', {
    style: { format: 'dd/MM/yyyy HH:mm' },
    timezone: 'Asia/Ho_Chi_Minh',
  }),
  done: field('done', 'checkbox'),
  status: field('status', 'select', statusOptions),
  tags: field('tags', 'select', tagOptions),
  owners: field('owners', 'user'),
  assignee: field('assignee', 'user', { multiple: false }),
  created: field('created', 'created_at'),
  updated: field('updated', 'updated_at'),
  creator: field('creator', 'created_by'),
  updater: field('updater', 'updated_by'),
} as const;

export type FixtureFieldKey = keyof typeof fields;
export const FIELD_LIST: readonly FixtureField[] = Object.values(fields);
export const tableMeta: SqlFilterTableMeta = { fields: FIELD_LIST, collation: COLLATION };
export const visibleFieldIds = FIELD_LIST.map((item) => item.id);

/** Physical column of a field (its own column or the system column it points at). */
export function columnOf(item: FixtureField): string {
  return FIELD_TYPE_REGISTRY[item.type].systemColumn ?? (item.dbColumnName as string);
}

// ---------------------------------------------------------------------------
// Value pools.

export const TEXTS: readonly (string | null)[] = [
  'Nguyễn Văn An',
  'nguyen van an',
  'NGUYỄN VĂN ÂN',
  'Nguyen Van Anh',
  'Đặng Thị Đào',
  'dang thi dao',
  'ĐẶNG THỊ ĐÀO',
  'Trần Đức Bo',
  'tran duc bo',
  'Lê Thị Ánh Tuyết',
  'Phạm Hồng Nhung',
  'Hồ Chí Minh',
  'Hà Nội',
  'ha noi',
  'Đà Nẵng',
  'Cà phê sữa đá',
  'ca phe sua da',
  'Café',
  'Cafe\u0301 (NFD)',
  'Phở bò tái',
  'Bún chả',
  'Khoẻ',
  'Khỏe',
  'Thuý Kiều',
  'Thúy Kiều',
  '100%',
  '100% cotton',
  '50%_off',
  'a_b',
  'a%b',
  'aXb',
  'a\\b',
  'back\\slash\\',
  '\\%',
  "O'Brien",
  "'; DROP TABLE data.t_t105harness1; --",
  '"quoted"',
  'tab\there',
  'line\nbreak',
  '  leading and trailing  ',
  'x',
  'X',
  'đ',
  'Đ',
  'd',
  'ÆSIR œuvre',
  'Straße',
  'STRASSE',
  'İstanbul',
  'ΟΔΟΣ',
  'οδος',
  'ﬁle',
  '％ full width ＿',
  'Ⅻ roman',
  'Łódź',
  'Ørsted',
  'emoji 😀 test',
  '',
  null,
];

/** Needles for text operators (never empty: an empty string is not a filter value, SPEC §6.1). */
export const TEXT_NEEDLES: readonly string[] = [
  'nguyen',
  'Nguyễn',
  'NGUYEN VAN AN',
  'nguyễn văn ân',
  'Nguyen Van Anh',
  'an',
  'đ',
  'Đ',
  'd',
  'dao',
  'ĐÀO',
  'thi',
  'ca phe',
  'café',
  'cafe',
  'khoe',
  'thuy kieu',
  'x',
  '%',
  '_',
  '\\',
  '\\%',
  '%%',
  'a_b',
  'a%b',
  '100%',
  '_off',
  "'",
  "O'B",
  "'; DROP TABLE data.t_t105harness1; --",
  "' OR '1'='1",
  '"',
  '％',
  '＿',
  'strasse',
  'ss',
  'istanbul',
  'οδος',
  'ΟΔΟΣ',
  'fi',
  'aesir',
  'lodz',
  'orsted',
  '😀',
  '  leading',
  'trailing  ',
  '\u0301',
  'zzz-not-found',
];

/** Not exactly representable: a double whose shortest decimal form is 12345678901234567000. */
const BIG_DOUBLE = Number('12345678901234567890');

export const NUMBERS: readonly (number | string | null)[] = [
  0,
  -0,
  1,
  -1,
  1.5,
  -1.5,
  2,
  0.1,
  0.2,
  0.3,
  0.1 + 0.2,
  0.0001,
  -0.0001,
  0.5,
  0.25,
  0.99,
  3,
  4,
  5,
  100,
  1_000_000,
  1_500_000.5,
  999_999_999_999.99,
  1e15,
  BIG_DOUBLE,
  -BIG_DOUBLE,
  // Beyond double precision: possible in numeric (e.g. after a type conversion).
  '1.00000000000000000001',
  '0.99999999999999999999',
  '-0.00000000000000000001',
  '12345678901234567890.123456789',
  '0.30000000000000000000',
  null,
];

export const NUMBER_OPERANDS: readonly number[] = [
  0,
  1,
  -1,
  1.5,
  -1.5,
  0.3,
  0.1 + 0.2,
  0.0001,
  0.25,
  2,
  5,
  100,
  1_000_000,
  1e15,
  BIG_DOUBLE,
  1e-7,
];

export const NUMBER_PAIRS: readonly [number, number][] = [
  [0, 1],
  [1, 0],
  [-1.5, 1.5],
  [0.3, 0.3],
  [0.1 + 0.2, 1e15],
  [1, BIG_DOUBLE],
  [-1e20, 0],
];

/** Instants around DST in New York (2026-03-08, 2026-11-01) and midnights in Ho Chi Minh (UTC+7). */
export const INSTANTS: readonly (string | null)[] = [
  '2026-03-07T04:59:59.999Z',
  '2026-03-07T05:00:00.000Z',
  '2026-03-07T16:59:59.999Z',
  '2026-03-07T17:00:00.000Z',
  '2026-03-08T04:59:59.999Z',
  '2026-03-08T04:59:59.999999Z',
  '2026-03-08T05:00:00.000Z',
  '2026-03-08T05:00:00.000500Z',
  '2026-03-08T06:59:59.999Z',
  '2026-03-08T07:00:00.000Z',
  '2026-03-08T15:00:00.000Z',
  '2026-03-08T15:00:00.000400Z',
  '2026-03-08T16:59:59.999Z',
  '2026-03-08T17:00:00.000Z',
  '2026-03-09T03:59:59.999Z',
  '2026-03-09T04:00:00.000Z',
  '2026-03-01T05:00:00.000Z',
  '2026-02-28T16:59:59.999Z',
  '2026-03-02T05:00:00.000Z',
  '2026-10-31T16:59:59.999Z',
  '2026-10-31T17:00:00.000Z',
  '2026-11-01T03:59:59.999Z',
  '2026-11-01T04:00:00.000Z',
  '2026-11-01T05:30:00.000Z',
  '2026-11-01T05:45:00.000Z',
  '2026-11-01T06:30:00.000Z',
  '2026-11-01T16:59:59.999Z',
  '2026-11-01T17:00:00.000Z',
  '2026-11-02T04:59:59.999Z',
  '2026-11-02T05:00:00.000Z',
  '2026-10-01T04:00:00.000Z',
  '2026-09-30T17:00:00.000Z',
  '2026-12-31T23:59:59.999Z',
  '2027-01-01T05:00:00.000Z',
  '2025-12-31T16:59:59.999Z',
  '2026-01-01T00:00:00.000Z',
  null,
];

export const DATES: readonly (string | null)[] = [
  '2026-03-01',
  '2026-03-02',
  '2026-03-06',
  '2026-03-07',
  '2026-03-08',
  '2026-03-09',
  '2026-03-15',
  '2026-02-01',
  '2026-02-28',
  '2026-10-01',
  '2026-10-26',
  '2026-10-31',
  '2026-11-01',
  '2026-11-02',
  '2026-11-08',
  '2026-11-30',
  '2026-12-31',
  '2026-01-01',
  '2025-12-31',
  '2027-01-01',
  null,
];

const rel = (relative: (typeof RELATIVE_DATES)[number], amount?: number): FilterOperand =>
  amount === undefined ? { $date: { relative } } : { $date: { relative, amount } };

export const DATE_OPERANDS: readonly FilterOperand[] = [
  { $var: 'today' },
  { $var: 'now' },
  ...RELATIVE_DATES.flatMap((relative) =>
    RELATIVE_DATES_WITH_AMOUNT.has(relative)
      ? [rel(relative, 0), rel(relative, 1), rel(relative, 7), rel(relative, 30)]
      : [rel(relative)],
  ),
  '2026-03-08',
  '2026-11-01',
  '2026-03-07',
  { $date: { exact: '2026-03-08T02:30' } },
  { $date: { exact: '2026-11-01T01:30' } },
  { $date: { exact: '2026-03-08T00:00' } },
  '2026-11-01T01:45',
];

export const DATE_PAIRS: readonly [FilterOperand, FilterOperand][] = [
  ['2026-03-07', '2026-03-08'],
  ['2026-03-08', '2026-03-07'],
  [rel('last_month'), { $var: 'today' }],
  [rel('days_ago', 7), rel('days_from_now', 7)],
  [{ $var: 'now' }, rel('this_year')],
  ['2026-10-31T23:00', '2026-11-01T01:30'],
];

// ---------------------------------------------------------------------------
// Records.

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type StorageRow = Record<string, unknown>;

export const RECORD_COUNT = 360;

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T;

function subset<T>(random: () => number, items: readonly T[]): T[] {
  return items.filter(() => random() < 0.35);
}

/** A list cell: null, `{}`, a random subset, or (rarely) one with a duplicate. */
function listCell<T>(random: () => number, items: readonly T[], single: boolean): T[] | null {
  const roll = random();
  if (roll < 0.1) return null;
  if (roll < 0.18) return [];
  if (single) return [pick(random, items)];
  if (roll < 0.21) {
    const item = pick(random, items);
    return [item, item];
  }
  return subset(random, items);
}

/** Storage values per physical column (as `toStorage` would produce, plus edge cases it never emits). */
export function buildRecords(): StorageRow[] {
  const random = prng(105);
  const rows: StorageRow[] = [];
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    const text = (pool: readonly (string | null)[]) =>
      index < pool.length ? pool[index] : pick(random, pool);
    const row: StorageRow = {
      __id: fixedId('rec', `r${String(index).padStart(4, '0')}`),
      [columnOf(fields.title)]: text(TEXTS),
      [columnOf(fields.phone)]:
        random() < 0.4
          ? pick(random, ['+84 912 345 678', '0912-345-678', '(028) 3823 4567', '', null])
          : pick(random, TEXTS),
      [columnOf(fields.code)]:
        random() < 0.5 ? `NO.${String(index).padStart(3, '0')}` : pick(random, TEXTS),
      [columnOf(fields.amount)]: index < NUMBERS.length ? NUMBERS[index] : pick(random, NUMBERS),
      [columnOf(fields.price)]:
        random() < 0.5 ? pick(random, NUMBERS) : Math.round(random() * 5_000_000),
      [columnOf(fields.progress)]: pick(random, [
        0,
        0.0001,
        0.1,
        0.25,
        0.5,
        0.99,
        1,
        0.3,
        0.1 + 0.2,
        -1.5,
        1.5,
        2,
        null,
      ]),
      [columnOf(fields.rating)]: pick(random, [0, 1, 2, 3, 4, 5, 100, 1e15, -1, null]),
      [columnOf(fields.due)]: index < DATES.length ? DATES[index] : pick(random, DATES),
      [columnOf(fields.dueNy)]: index < INSTANTS.length ? INSTANTS[index] : pick(random, INSTANTS),
      [columnOf(fields.meetHcm)]: pick(random, INSTANTS),
      [columnOf(fields.done)]: random() < 0.5,
      [columnOf(fields.status)]: listCell(random, STATUS, true),
      [columnOf(fields.tags)]: listCell(random, TAGS, false),
      [columnOf(fields.owners)]: listCell(random, STORED_USERS, false),
      [columnOf(fields.assignee)]: listCell(random, STORED_USERS, true),
      __created_at: pick(
        random,
        INSTANTS.filter((value) => value !== null),
      ),
      __updated_at: pick(
        random,
        INSTANTS.filter((value) => value !== null),
      ),
      __created_by: pick(random, [...STORED_USERS, null, '']),
      __updated_by: pick(random, [...STORED_USERS, null]),
    };
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Cases: every operator a field allows × the operand pool of its group.

export interface FilterCase {
  readonly name: string;
  readonly filter: FilterNode;
}

const OPTION_LISTS: readonly (readonly string[])[] = [
  [opt.new],
  [opt.done],
  [opt.new, opt.done],
  [opt.doing, opt.hold, opt.new],
];
const TAG_LISTS: readonly (readonly string[])[] = [
  [opt.a],
  [opt.b],
  [opt.a, opt.b],
  [opt.a, opt.b, opt.c],
  [opt.c, opt.d, opt.e],
  TAGS,
];
const USER_LISTS: readonly FilterValue[] = [
  [usr.an],
  [usr.binh],
  [usr.ghost],
  [usr.an, usr.binh],
  [usr.an, usr.binh, usr.chi, usr.dung, usr.giang],
  [{ $var: 'current_user' }],
  [{ $var: 'current_user_groups' }],
  [{ $var: 'current_user' }, usr.dung],
  [{ $var: 'current_user_groups' }, usr.giang],
];

function operandsFor(item: FixtureField, operator: DslOperator): FilterValue[] {
  if (operator === 'is_empty' || operator === 'is_not_empty') return [null];
  const profile = fieldProfile(item);
  switch (profile.group) {
    case 'text':
      return [...TEXT_NEEDLES];
    case 'number':
      return operator === 'between' ? NUMBER_PAIRS.map((pair) => [...pair]) : [...NUMBER_OPERANDS];
    case 'datetime':
      return operator === 'between' ? DATE_PAIRS.map((pair) => [...pair]) : [...DATE_OPERANDS];
    case 'checkbox':
      return [true, false];
    case 'single_select':
      return operator === 'is' || operator === 'is_not'
        ? [...STATUS]
        : OPTION_LISTS.map((list) => [...list]);
    default:
      if (profile.element === 'option') return TAG_LISTS.map((list) => [...list]);
      return [...USER_LISTS];
  }
}

export function buildCases(): FilterCase[] {
  const cases: FilterCase[] = [];
  for (const item of FIELD_LIST) {
    for (const operator of allowedOperators(fieldProfile(item), 'standard')) {
      for (const operand of operandsFor(item, operator)) {
        const filter: FilterNode =
          operand === null
            ? { field: item.id, operator }
            : { field: item.id, operator, value: operand };
        cases.push({ name: `${item.name} ${operator} ${JSON.stringify(operand)}`, filter });
      }
    }
  }
  return cases;
}

/** Random `and`/`or`/`not` trees over the flat cases (depth ≤ 4, ≤ 12 conditions). */
export function buildTrees(flat: readonly FilterCase[], count: number, seed: number): FilterCase[] {
  const random = prng(seed);
  const tree = (depth: number): FilterNode => {
    const roll = random();
    if (depth >= 4 || roll < 0.35) return pick(random, flat).filter;
    if (roll < 0.5) return { op: 'not', item: tree(depth + 1) };
    const size = 1 + Math.floor(random() * 3);
    return {
      op: random() < 0.5 ? 'and' : 'or',
      items: Array.from({ length: size }, () => tree(depth + 1)),
    };
  };
  const trees: FilterCase[] = [
    { name: 'empty and', filter: { op: 'and', items: [] } },
    { name: 'empty or', filter: { op: 'or', items: [] } },
  ];
  for (let index = 0; index < count; index += 1) {
    const filter: FilterNode = { op: random() < 0.5 ? 'and' : 'or', items: [tree(1), tree(1)] };
    trees.push({ name: `tree #${String(index)}`, filter });
  }
  return trees;
}
