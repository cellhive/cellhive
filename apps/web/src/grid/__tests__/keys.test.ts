import { describe, expect, it } from 'vitest';

import { isTextTarget, pageShortcut } from '../undo/keys';

const none = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

describe('pageShortcut (FRONTEND §6.2)', () => {
  it.each([
    ['Ctrl+Z', { ...none, key: 'z', ctrlKey: true }, 'undo'],
    ['⌘+Z', { ...none, key: 'z', metaKey: true }, 'undo'],
    ['Shift+Ctrl+Z', { ...none, key: 'Z', ctrlKey: true, shiftKey: true }, 'redo'],
    ['Shift+⌘+Z', { ...none, key: 'z', metaKey: true, shiftKey: true }, 'redo'],
    ['Ctrl+Y', { ...none, key: 'y', ctrlKey: true }, 'redo'],
    ['⌘+Y is not redo (browser history on macOS)', { ...none, key: 'y', metaKey: true }, null],
    ['?', { ...none, key: '?', shiftKey: true }, 'shortcuts'],
    ['Alt+Ctrl+Z', { ...none, key: 'z', ctrlKey: true, altKey: true }, null],
    ['plain z', { ...none, key: 'z' }, null],
  ] as const)('%s', (_name, event, expected) => {
    expect(pageShortcut(event)).toBe(expected);
  });
});

describe('isTextTarget', () => {
  it('text fields keep their keys; buttons and cells do not', () => {
    const text = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const area = document.createElement('textarea');
    const cell = document.createElement('td');
    expect(isTextTarget(text)).toBe(true);
    expect(isTextTarget(area)).toBe(true);
    expect(isTextTarget(checkbox)).toBe(false);
    expect(isTextTarget(cell)).toBe(false);
    expect(isTextTarget(null)).toBe(false);
  });
});
