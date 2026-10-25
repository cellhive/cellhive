import { describe, expect, it } from 'vitest';

import { placementAt } from '../tree/draw';
import { treeKeyAction, treeShortcutLabel, type TreeKeyContext } from '../tree/keys';

const CONTEXT: TreeKeyContext = {
  gridFocused: true,
  editing: false,
  column: 0,
  hasChildren: true,
  expanded: false,
  hasParent: true,
};

const key = (value: string, extra: Partial<Parameters<typeof treeKeyAction>[0]> = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe('tree keys (T417, BACKLOG S4 design decision 3)', () => {
  it.each([
    ['Ctrl+]', key(']', { ctrlKey: true, code: 'BracketRight' }), 'indent'],
    ['⌘+]', key(']', { metaKey: true, code: 'BracketRight' }), 'indent'],
    ['Ctrl+[', key('[', { ctrlKey: true, code: 'BracketLeft' }), 'outdent'],
    ['⌘+[', key('[', { metaKey: true, code: 'BracketLeft' }), 'outdent'],
    // Another layout: the key is not "]" but the physical key is.
    ['⌘+] (AZERTY)', key('$', { metaKey: true, code: 'BracketRight' }), 'indent'],
    ['Alt+Shift+→', key('ArrowRight', { altKey: true, shiftKey: true }), 'indent'],
    ['Alt+Shift+←', key('ArrowLeft', { altKey: true, shiftKey: true }), 'outdent'],
  ] as const)('%s', (_, event, action) => {
    expect(treeKeyAction(event, CONTEXT)).toBe(action);
  });

  it('keeps ⌘+[ / ⌘+] for the browser (Back / Forward) unless the grid has the focus', () => {
    const back = key('[', { metaKey: true, code: 'BracketLeft' });
    expect(treeKeyAction(back, { ...CONTEXT, gridFocused: false })).toBeNull();
  });

  it('never takes the brackets while a cell editor is open', () => {
    const forward = key(']', { metaKey: true, code: 'BracketRight' });
    expect(treeKeyAction(forward, { ...CONTEXT, editing: true })).toBeNull();
    expect(
      treeKeyAction(key('ArrowRight', { altKey: true, shiftKey: true }), {
        ...CONTEXT,
        editing: true,
      }),
    ).toBeNull();
  });

  it('leaves Tab and Shift+Tab to move between cells', () => {
    expect(treeKeyAction(key('Tab'), CONTEXT)).toBeNull();
    expect(treeKeyAction(key('Tab', { shiftKey: true }), CONTEXT)).toBeNull();
  });

  it('opens and closes a branch with → / ← on the first column only', () => {
    expect(treeKeyAction(key('ArrowRight'), CONTEXT)).toBe('expand');
    expect(treeKeyAction(key('ArrowRight'), { ...CONTEXT, expanded: true })).toBeNull();
    expect(treeKeyAction(key('ArrowLeft'), { ...CONTEXT, expanded: true })).toBe('collapse');
    expect(treeKeyAction(key('ArrowLeft'), CONTEXT)).toBe('parent');
    expect(treeKeyAction(key('ArrowLeft'), { ...CONTEXT, hasParent: false })).toBeNull();
    expect(treeKeyAction(key('ArrowRight'), { ...CONTEXT, column: 2 })).toBeNull();
    expect(treeKeyAction(key('ArrowRight'), { ...CONTEXT, hasChildren: false })).toBeNull();
  });

  it('ignores other shortcuts', () => {
    expect(treeKeyAction(key('c', { metaKey: true }), CONTEXT)).toBeNull();
    expect(treeKeyAction(key(']', { metaKey: true, shiftKey: true }), CONTEXT)).toBeNull();
    expect(treeKeyAction(key('ArrowUp', { altKey: true, shiftKey: true }), CONTEXT)).toBeNull();
  });

  it('labels the shortcuts per platform', () => {
    expect(treeShortcutLabel('indent', true)).toBe('⌘]');
    expect(treeShortcutLabel('outdent', false)).toBe('Ctrl+[');
  });

  it.each([
    [0.1, 'before'],
    [0.5, 'child'],
    [0.9, 'after'],
  ] as const)('a drop %f down a row is %s', (fraction, placement) => {
    expect(placementAt(fraction)).toBe(placement);
  });
});
