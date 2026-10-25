/**
 * Minimal SPDX license expression parser (SPDX spec, annex D).
 *
 * Grammar (AND binds tighter than OR):
 *   or    := and ('OR' and)*
 *   and   := with ('AND' with)*
 *   with  := atom ('WITH' exceptionId)?
 *   atom  := licenseId | '(' or ')'
 *
 * `WITH` exceptions only ever widen what a license permits, so the node keeps
 * the base license id and the exception is dropped.
 */
export type SpdxNode =
  | { readonly kind: 'license'; readonly id: string }
  | { readonly kind: 'and' | 'or'; readonly left: SpdxNode; readonly right: SpdxNode };

export class SpdxParseError extends Error {
  override readonly name = 'SpdxParseError';
}

type Token =
  | { readonly type: 'lparen' | 'rparen' | 'and' | 'or' | 'with' }
  | { readonly type: 'id'; readonly value: string };

const ID_PATTERN = /^[A-Za-z0-9.+:-]+$/;

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of expression.replaceAll('(', ' ( ').replaceAll(')', ' ) ').split(/\s+/)) {
    if (raw === '') continue;
    if (raw === '(') tokens.push({ type: 'lparen' });
    else if (raw === ')') tokens.push({ type: 'rparen' });
    else if (raw.toUpperCase() === 'AND') tokens.push({ type: 'and' });
    else if (raw.toUpperCase() === 'OR') tokens.push({ type: 'or' });
    else if (raw.toUpperCase() === 'WITH') tokens.push({ type: 'with' });
    else if (ID_PATTERN.test(raw)) tokens.push({ type: 'id', value: raw });
    else throw new SpdxParseError(`Invalid token "${raw}" in "${expression}"`);
  }
  return tokens;
}

export function parseSpdx(expression: string): SpdxNode {
  const tokens = tokenize(expression);
  let pos = 0;

  const fail = (message: string): never => {
    throw new SpdxParseError(`${message} in "${expression}"`);
  };

  const parseAtom = (): SpdxNode => {
    const token = tokens[pos++];
    if (token === undefined) return fail('Unexpected end of expression');
    if (token.type === 'id') return { kind: 'license', id: token.value };
    if (token.type === 'lparen') {
      const inner = parseOr();
      if (tokens[pos++]?.type !== 'rparen') fail('Missing closing parenthesis');
      return inner;
    }
    return fail(`Unexpected "${token.type}"`);
  };

  const parseWith = (): SpdxNode => {
    const base = parseAtom();
    if (tokens[pos]?.type === 'with') {
      pos++;
      if (base.kind !== 'license') fail('WITH must follow a license id');
      if (tokens[pos++]?.type !== 'id') fail('WITH must be followed by an exception id');
    }
    return base;
  };

  const parseBinary = (op: 'and' | 'or', next: () => SpdxNode): SpdxNode => {
    let left = next();
    while (tokens[pos]?.type === op) {
      pos++;
      left = { kind: op, left, right: next() };
    }
    return left;
  };

  const parseAnd = (): SpdxNode => parseBinary('and', parseWith);
  const parseOr = (): SpdxNode => parseBinary('or', parseAnd);

  if (tokens.length === 0) fail('Empty expression');
  const tree = parseOr();
  if (pos !== tokens.length) fail('Unexpected trailing tokens');
  return tree;
}

/** True when the expression is satisfiable using only licenses accepted by `isAllowed`. */
export function satisfies(node: SpdxNode, isAllowed: (id: string) => boolean): boolean {
  switch (node.kind) {
    case 'license':
      return isAllowed(node.id);
    case 'and':
      return satisfies(node.left, isAllowed) && satisfies(node.right, isAllowed);
    case 'or':
      return satisfies(node.left, isAllowed) || satisfies(node.right, isAllowed);
  }
}
