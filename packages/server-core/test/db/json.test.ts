import { describe, expect, it } from 'vitest';

import { storableJsonText, storableJsonValue } from '../../src/db/json.js';

import type { JsonValue } from '../../src/db/schema.js';

describe('storableJsonText (QA S5c)', () => {
  it.each([
    ['a\u0000b', 'a�b'],
    ['\ud800', '�'],
    ['x\udc00y', 'x�y'],
    // A valid pair stays.
    ['😀', '😀'],
    ['Việt Nam', 'Việt Nam'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(storableJsonText(input)).toBe(expected);
  });
});

describe('storableJsonValue (QA S5c)', () => {
  it('fixes strings and keys at any position, keeps other values', () => {
    const input = JSON.parse(
      '{"a\\u0000":"x\\u0000","list":[1,true,null,"\\ud800",{"k":"😀"}],"n":1.5}',
    ) as JsonValue;
    expect(storableJsonValue(input)).toEqual({
      'a�': 'x�',
      list: [1, true, null, '�', { k: '😀' }],
      n: 1.5,
    });
    // The input is not changed.
    expect(input).toHaveProperty(['a\u0000'], 'x\u0000');
  });

  it('keeps `__proto__` as a plain own key', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}') as JsonValue;
    const out = storableJsonValue(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":true}}');
  });

  it('handles nesting far deeper than the call stack allows', () => {
    const depth = 200_000;
    const input = JSON.parse(`${'['.repeat(depth)}"\\u0000"${']'.repeat(depth)}`) as JsonValue;
    let cursor = storableJsonValue(input);
    let levels = 0;
    while (Array.isArray(cursor)) {
      cursor = cursor[0] as JsonValue;
      levels += 1;
    }
    expect(levels).toBe(depth);
    expect(cursor).toBe('�');
  });

  it.each([null, 0, 'plain', true])('scalar %j stays', (value) => {
    expect(storableJsonValue(value)).toBe(value);
  });
});
