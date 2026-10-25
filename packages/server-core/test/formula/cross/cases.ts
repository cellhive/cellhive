/**
 * Cross-table cases of the formula harness (BACKLOG T455), on the base of
 * `base.ts`. Expected values follow the value conventions of SPEC §9.4
 * (numbers as decimal text, lists as arrays, empty list ≡ NULL) and are
 * derived by hand from the data:
 *
 * - "My orders" (reverse side `b`, creation order of the orders):
 *   c1 → O1 (100, Paid), O2 (250, New), O4 (40, Shipped) — O5 is in the
 *   trash; c2 → O3 (75.5, Paid), O4; c3, c5 → none;
 * - Orders.Items (side `a`, link order): O1 → P2, P1; O2 → P3; O4 → P1;
 *   BIG → B500 … B001 (500 links); Products.Supplier: P1, P3, odd B → Acme,
 *   P2, even B → Globex;
 * - Referrer: c2 → c1, c3 → c2, c5 → c4 (trash), c3; Friends: c1 → c3, c2;
 *   c2 → c3 ("Friend of": c2 → c1; c3 → c1, c2); Archived: c1 → a1 (Archive
 *   is in the trash).
 *
 * `scope` applies a read rule per source table (`sourceScope`): `paid`
 * keeps Paid orders, `hcm` customers of HCM.
 *
 * TS evaluator (T453): when it merges, the same cases run through
 * `evaluate` with a resolver over the same data (to be wired in
 * `fixture-source.ts`); the expected values here are the contract.
 */
import type { TableName } from './base.js';
import type { LookupOptions } from '@cellhive/formula-engine';

export type ScopeName = 'paid' | 'hcm';

export interface CrossCase {
  readonly name: string;
  readonly table: TableName;
  /** Record key (`base.ts` `rid`). */
  readonly record: string;
  readonly formula?: string;
  /** A lookup field instead of a formula; field names are resolved to ids by the runner. */
  readonly lookup?: {
    readonly from: TableName;
    readonly select: string;
    readonly where: LookupWhereSpec;
    readonly aggregate?: LookupOptions['aggregate'];
  };
  readonly scope?: Partial<Record<TableName, ScopeName>>;
  readonly expected: unknown;
}

/** A lookup `where` by field names (`{ ref: 'Code' }` = field_ref, `{ ref: '__id' }`). */
export type LookupWhereSpec =
  | { readonly field: string; readonly operator: string; readonly value?: unknown }
  | { readonly op: 'and' | 'or'; readonly items: LookupWhereSpec[] };

const cases: CrossCase[] = [];
const names = new Map<string, number>();

function add(
  table: TableName,
  record: string,
  formula: string,
  expected: unknown,
  scope?: CrossCase['scope'],
): void {
  const base = `${table}/${record}: ${formula}${scope === undefined ? '' : ` ${JSON.stringify(scope)}`}`;
  const count = (names.get(base) ?? 0) + 1;
  names.set(base, count);
  cases.push({
    name: count === 1 ? base : `${base} #${String(count)}`,
    table,
    record,
    formula,
    expected,
    ...(scope === undefined ? {} : { scope }),
  });
}

function lookup(
  record: string,
  spec: NonNullable<CrossCase['lookup']>,
  expected: unknown,
  scope?: CrossCase['scope'],
): void {
  cases.push({
    name: `Customers/${record}: lookup ${JSON.stringify(spec)}${scope === undefined ? '' : ` ${JSON.stringify(scope)}`}`,
    table: 'Customers',
    record,
    lookup: spec,
    expected,
    ...(scope === undefined ? {} : { scope }),
  });
}

// --- Link, reverse side (b), aggregates ------------------------------------
add('Customers', 'c1', '[My orders].[Amount].SUM()', '390');
add('Customers', 'c2', '[My orders].[Amount].SUM()', '115.5');
add('Customers', 'c3', '[My orders].[Amount].SUM()', '0');
add('Customers', 'c1', '[My orders].[Amount].AVERAGE()', '130');
add('Customers', 'c1', '[My orders].[Amount].MAX()', '250');
add('Customers', 'c3', '[My orders].[Amount].MAX()', null);
add('Customers', 'c1', '[My orders].[Ref]', ['O1', 'O2', 'O4']);
add('Customers', 'c2', '[My orders].[Ref]', ['O3', 'O4']);
add('Customers', 'c1', 'COUNTA([My orders])', '3');
add('Customers', 'c3', 'COUNTA([My orders])', '0');
add('Customers', 'c3', 'ISBLANK([My orders])', true);
add('Customers', 'c1', 'ISBLANK([My orders])', false);
add('Customers', 'c1', '[My orders].[Date].MAX()', '2026-02-10');
add('Customers', 'c1', '[My orders].[Status]', ['Paid', 'New', 'Shipped']);
add('Customers', 'c1', '[My orders].[Status].UNIQUE().COUNTA()', '3');

// --- Chains (≤ 3 links) -----------------------------------------------------
add('Customers', 'c1', '[My orders].[Items].[SKU]', ['P2', 'P1', 'P3', 'P1']);
add('Customers', 'c1', '[My orders].[Items].[Price].SUM()', '8');
add('Customers', 'c1', '[My orders].[Items].[Supplier].[Company]', [
  'Globex',
  'Acme',
  'Acme',
  'Acme',
]);
add('Customers', 'c1', '[My orders].[Items].[Supplier].[Company].UNIQUE()', ['Globex', 'Acme']);
add('Customers', 'c3', '[My orders].[Items].[Supplier].[Company]', []);
add('Orders', 'o3', '[Customer].[Referrer].[Name]', ['An']);
add('Orders', 'o3', '[Customer].[My orders].[Ref]', ['O3', 'O4']);
add('Orders', 'o4', '[Customer].[Name]', ['Bình', 'An']);
add('Orders', 'o7', '[Customer].[Name]', []);
add('Orders', 'o1', '[Items].[Supplier].[Country]', ['US', 'VN']);

// --- Iteration over linked records ------------------------------------------
add('Customers', 'c1', '[My orders].FILTER(CurrentValue.[Status] = "Paid").[Amount].SUM()', '100');
add('Customers', 'c2', '[My orders].FILTER(CurrentValue.[Amount] > 50).[Ref]', ['O3']);
add('Customers', 'c1', '[My orders].SORTBY(CurrentValue.[Amount]).[Ref]', ['O4', 'O1', 'O2']);
add('Customers', 'c1', '[My orders].SORTBY(CurrentValue.[Amount], FALSE).[Ref]', [
  'O2',
  'O1',
  'O4',
]);
add('Customers', 'c1', '[My orders].FIRST().[Ref]', 'O1');
add('Customers', 'c1', '[My orders].LAST().[Ref]', 'O4');
add('Customers', 'c1', '[My orders].NTH(2).[Ref]', 'O2');
add('Customers', 'c1', '[My orders].NTH(9).[Ref]', null);
add('Customers', 'c3', '[My orders].FIRST().[Ref]', null);
add('Customers', 'c1', 'ARRAYJOIN([My orders])', 'O1, O2, O4');
add('Customers', 'c2', 'ARRAYJOIN([My orders], "|")', 'O3|O4');
add('Customers', 'c3', 'ARRAYJOIN([My orders])', '');
add('Customers', 'c2', '[My orders].[Labels].LISTCOMBINE()', ['Gift', 'Urgent']);
add('Customers', 'c1', '[My orders].[Labels].LISTCOMBINE().UNIQUE()', ['Urgent']);
add('Customers', 'c2', 'COUNTA([My orders].[Labels])', '1');
add('Customers', 'c3', 'ISBLANK([My orders].[Labels])', true);
add('Customers', 'c2', '[My orders].MAP(CurrentValue.[Amount] * 2)', ['151', '80']);
add('Customers', 'c1', 'COUNTIF([My orders], CurrentValue.[Status] = "Paid")', '1');
add(
  'Customers',
  'c1',
  'SUMIF([My orders], CurrentValue.[Status] != "New", CurrentValue.[Amount])',
  '140',
);
add('Customers', 'c1', 'CONTAIN([My orders], "O2")', true);
add('Customers', 'c1', 'CONTAIN([My orders], "O3")', false);
add('Customers', 'c1', 'CONTAINSALL([My orders], "O1", "O4")', true);
add('Customers', 'c1', 'CONTAINSALL([My orders], "O1", "O3")', false);
add('Customers', 'c2', 'CONTAINSONLY([My orders], "O3", "O4")', true);
add('Customers', 'c1', 'CONTAINSONLY([My orders], "O1", "O2")', false);

// --- Self-links (one-way, two-way both sides) --------------------------------
add('Customers', 'c3', '[Referrer].[Name]', ['Bình']);
add('Customers', 'c3', '[Referrer].[Referrer].[Name]', ['An']);
add('Customers', 'c5', '[Referrer].[Name]', ['Chi']);
add('Customers', 'c1', '[Friends].[Name]', ['Chi', 'Bình']);
add('Customers', 'c3', '[Friend of].[Name]', ['An', 'Bình']);
add('Customers', 'c2', '[Friend of].[Name]', ['An']);
add('Customers', 'c1', '[Friends].[Score].AVERAGE()', '5');
add('Customers', 'c1', '[Friends].FILTER(CurrentValue.[Friend of].CONTAIN(RECORD_ID())).[Name]', [
  'Chi',
  'Bình',
]);
add('Customers', 'c3', 'FIRST([Referrer]) = "Bình"', true);
add('Customers', 'c3', 'FIRST([Referrer]) = "An"', false);
add('Customers', 'c2', 'FIRST([Friend of]) = FIRST([Referrer])', true);
add('Customers', 'c3', 'FIRST([Friend of]) = FIRST([Referrer])', false);
add('Customers', 'c2', '"Ref: " & FIRST([Referrer])', 'Ref: An');
add('Customers', 'c1', '"Ref: " & FIRST([Referrer])', 'Ref: ');
add('Customers', 'c1', 'CONTAIN([Friends].[Name], "Chi")', true);
add('Customers', 'c1', 'CONTAIN(LIST("Chi", "Zed"), FIRST([Friends]))', true);

// --- Table in the trash, 500 links ------------------------------------------
add('Customers', 'c1', '[Archived].[Name]', []);
add('Customers', 'c1', 'COUNTA([Archived])', '0');
add('Customers', 'c1', '[Archive].[Name]', []);
add('Customers', 'c1', 'COUNTIF([Archive], TRUE)', '0');
add('Orders', 'big', '[Items].[Price].SUM()', '125250');
add('Orders', 'big', 'COUNTA([Items])', '500');
add('Orders', 'big', '[Items].[SKU].FIRST()', 'B500');
add('Orders', 'big', '[Items].[SKU].LAST()', 'B001');
add('Orders', 'big', '[Items].FILTER(CurrentValue.[Price] > 498).[SKU]', ['B500', 'B499']);
add('Orders', 'big', '[Items].[Supplier].[Company].UNIQUE()', ['Globex', 'Acme']);

// --- [Table], FILTER with CurrentValue (record and value), LOOKUP -----------
add(
  'Customers',
  'c1',
  '[Orders].FILTER(CurrentValue.[Customer].CONTAIN([Name])).[Amount].SUM()',
  '390',
);
add(
  'Customers',
  'c2',
  '[Orders].FILTER(CurrentValue.[Customer].CONTAIN([Name])).[Amount].SUM()',
  '115.5',
);
add('Customers', 'c1', '[Orders].FILTER(CurrentValue.[Code] = [Code]).[Amount].SUM()', '350');
add('Customers', 'c3', '[Orders].FILTER(CurrentValue.[Code] = [Code]).[Amount].SUM()', '0');
add(
  'Customers',
  'c2',
  '[Orders].FILTER(CurrentValue.[Code] = [Code] && CurrentValue.[Status] = "Paid").[Ref]',
  ['O3'],
);
add('Customers', 'c1', 'COUNTIF([Orders], CurrentValue.[Customer].CONTAIN(RECORD_ID()))', '3');
add('Customers', 'c2', '[Orders].FILTER(CONTAIN(CurrentValue.[Customer], RECORD_ID())).[Ref]', [
  'O3',
  'O4',
]);
add('Customers', 'c1', 'LOOKUP([Code], [Orders].[Code], [Orders].[Amount]).SUM()', '350');
add('Customers', 'c2', 'LOOKUP([Code], [Orders].[Code], [Orders].[Ref])', ['O3', 'O4']);
add('Customers', 'c1', 'LOOKUP([Name], [Orders].[Customer], [Orders].[Ref])', ['O1', 'O2', 'O4']);
add('Customers', 'c1', '[Orders].[Ref].COUNTA()', '7');
add('Customers', 'c1', '[Orders].SORTBY([Orders].[Amount], FALSE).[Ref].FIRST()', 'O2');
add('Customers', 'c1', '[Orders].SORTBY(CurrentValue.[Date]).[Ref]', [
  'O1',
  'O2',
  'O3',
  'O6',
  'O7',
  'O4',
  'BIG',
]);
add('Customers', 'c1', '[Orders].FILTER(CurrentValue.[Customer].FIRST() = "Bình").[Ref]', [
  'O3',
  'O4',
]);
add(
  'Customers',
  'c1',
  '[Orders].MAP(CurrentValue.[Customer].ARRAYJOIN()).FILTER(CurrentValue != "")',
  ['An', 'An', 'Bình', 'Bình, An'],
);
add('Customers', 'c1', '[Orders].FILTER(CurrentValue.[Customer].[Tier].CONTAIN("Gold")).[Ref]', [
  'O1',
  'O2',
  'O4',
]);
add('Customers', 'c1', '[Orders].FILTER(CurrentValue.[Labels].CONTAIN("Gift")).[Ref]', [
  'O3',
  'O6',
]);
add('Customers', 'c1', '[Orders].[Labels].LISTCOMBINE().UNIQUE()', ['Urgent', 'Gift']);
add('Orders', 'o1', '[Customers].FILTER(CurrentValue.[Tags].CONTAIN("VIP")).[Name]', [
  'An',
  'Bình',
]);
add('Orders', 'o1', '[Customers].[Owner].LISTCOMBINE()', [
  'usr_fixtureuser00001',
  'usr_fixtureuser00002',
  'usr_fixtureuser00001',
]);
add('Orders', 'o1', '[Customers].[Joined].MIN()', '2025-01-10');
add(
  'Orders',
  'o1',
  '[Products].FILTER(CurrentValue.[Supplier].CONTAIN("Acme")).[SKU].COUNTA()',
  '252',
);
add(
  'Orders',
  'o1',
  'LET(x, [Customers].FILTER(CurrentValue.[City] = "HCM"), x.[Name].ARRAYJOIN() & "/" & x.[Score].SUM())',
  'An, Chi/10',
);

// --- Viewer scope (sourceScope) ----------------------------------------------
add('Customers', 'c1', '[My orders].[Amount].SUM()', '100', { Orders: 'paid' });
add('Customers', 'c1', '[Orders].FILTER(CurrentValue.[Code] = [Code]).[Amount].SUM()', '100', {
  Orders: 'paid',
});
add('Customers', 'c2', 'LOOKUP([Code], [Orders].[Code], [Orders].[Ref])', ['O3'], {
  Orders: 'paid',
});
add('Orders', 'o4', '[Customer].[Name]', ['An'], { Customers: 'hcm' });
add('Customers', 'c1', '[My orders].[Items].[SKU]', ['P2', 'P1'], { Orders: 'paid' });
add('Customers', 'c1', 'COUNTA([Friends])', '1', { Customers: 'hcm' });
add('Customers', 'c1', '[Orders].[Ref].COUNTA()', '3', { Orders: 'paid' });

// --- Lookup fields (lookupToAst → same compiler) ------------------------------
const viaLink: LookupWhereSpec = {
  field: 'Customer',
  operator: 'intersects',
  value: { ref: '__id' },
};
lookup('c1', { from: 'Orders', select: 'Amount', where: viaLink, aggregate: 'sum' }, '390');
lookup(
  'c1',
  {
    from: 'Orders',
    select: 'Amount',
    where: { op: 'and', items: [viaLink, { field: 'Status', operator: 'is', value: 'Paid' }] },
    aggregate: 'sum',
  },
  '100',
);
lookup(
  'c2',
  {
    from: 'Orders',
    select: 'Ref',
    where: { field: 'Code', operator: 'eq', value: { ref: 'Code' } },
    aggregate: 'raw_value',
  },
  ['O3', 'O4'],
);
lookup('c1', { from: 'Orders', select: 'Ref', where: viaLink, aggregate: 'counta' }, '3');
lookup('c1', { from: 'Orders', select: 'Status', where: viaLink, aggregate: 'unique_counta' }, '3');
lookup('c1', { from: 'Orders', select: 'Status', where: viaLink, aggregate: 'unique' }, [
  'Paid',
  'New',
  'Shipped',
]);
lookup('c1', { from: 'Orders', select: 'Date', where: viaLink, aggregate: 'max' }, '2026-02-10');
lookup('c2', { from: 'Orders', select: 'Amount', where: viaLink, aggregate: 'average' }, '57.75');
lookup('c2', { from: 'Orders', select: 'Amount', where: viaLink, aggregate: 'min' }, '40');
lookup('c2', { from: 'Orders', select: 'Labels', where: viaLink }, ['Gift', 'Urgent']);
lookup(
  'c1',
  {
    from: 'Orders',
    select: 'Ref',
    where: { field: 'Code', operator: 'disjoint', value: [{ ref: 'Code' }] },
  },
  ['O3', 'O4', 'O6', 'O7', 'BIG'],
);
lookup('c1', { from: 'Orders', select: 'Amount', where: viaLink, aggregate: 'sum' }, '100', {
  Orders: 'paid',
});

export const CROSS_CASES: readonly CrossCase[] = cases;
