import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../test/i18n';
import { createOverlayEditor } from '../editors/overlay';
import { TypeToEdit } from '../type-to-edit';
import { toGridField, type GridRecord } from '../types';

import type { EditorContext } from '../editors/types';
import type { FieldDto } from '@cellhive/contracts';
import type { GridCell, ProvideEditorComponent } from '@glideapps/glide-data-grid';
import type { i18n as I18n } from 'i18next';

/**
 * T803 (QA S6 L15, `t322a`): one owner decides where each key goes around
 * a cell editor. Glide gives the grid the focus a frame after the click that
 * opened the editor; when that frame comes late (a loaded machine), the
 * editor already has the focus and the keys typed meanwhile used to reach
 * the grid, which dropped them or started typing over the cell again.
 *
 * As in `GridView`: the grid is `host` (glide focuses one of its cells),
 * the editors render into `#portal`, a double click (Enter, F2) starts a
 * session with no first key, typing on a cell starts one with that key.
 */

let i18n: I18n;
let host: HTMLElement;
let gridCell: HTMLElement;
let portal: HTMLElement;
let typing: TypeToEdit;
let onAbandon: ReturnType<typeof vi.fn<() => void>>;

const PLACE = { x: 10, y: 10, height: 34 };
const NOW = '2026-09-24T00:00:00.000Z';
const field: FieldDto = {
  id: 'fld_Title00000000001',
  table_id: 'tbl_Orders0000000001',
  name: 'Title',
  type: 'text',
  options: { style: { type: 'plain' } },
  is_primary: true,
  required: false,
  unique_values: false,
  description: null,
  position: 0,
  created_at: NOW,
  updated_at: NOW,
};
const record = {
  id: 'rec_0123456789ABCDEF',
  version: 4,
  fields: { [field.id]: 'old value' },
} as unknown as GridRecord;
const context: EditorContext = {
  locale: { locale: 'en-US', timeZone: 'UTC' },
  orgId: 'org_0123456789ABCDEF',
  canCreateOption: () => false,
};

beforeAll(async () => {
  i18n = await createTestI18n('en');
});

beforeEach(() => {
  host = document.createElement('section');
  gridCell = document.createElement('div');
  gridCell.tabIndex = 0;
  host.append(gridCell);
  portal = document.createElement('div');
  portal.id = 'portal';
  document.body.append(host, portal);
  typing = new TypeToEdit();
  onAbandon = vi.fn<() => void>();
});

afterEach(() => {
  typing.end();
  host.remove();
  portal.remove();
});

/** Glide asks for the editor of the cell (`provideEditor`) and mounts it in `#portal`. */
function mountEditor(col: number, row: number, onFinished = vi.fn()) {
  const Editor = createOverlayEditor(
    toGridField(field),
    record,
    context,
    typing.inputFor(col, row),
  );
  if (Editor === undefined) throw new Error('no editor');
  const props = {
    onChange: vi.fn(),
    onFinishedEditing: onFinished,
    initialValue: undefined,
    target: { x: 0, y: 0, width: 200, height: 34 },
  } as unknown as Parameters<ProvideEditorComponent<GridCell>>[0];
  const container = document.createElement('div');
  portal.append(container);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <Editor {...props} />
      </I18nextProvider>
    </QueryClientProvider>,
    { container },
  );
}

/** A double click (or Enter, F2) on a cell: glide accepted to open its editor. */
function activate(col: number, row: number) {
  typing.start({ host, col, row, first: '', place: PLACE, label: 'Title', onAbandon });
}

async function editorInput(): Promise<HTMLTextAreaElement> {
  const input = await screen.findByRole('textbox', { name: 'Title' });
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('not a text area');
  return input;
}

describe('keys around a cell editor (T803)', () => {
  it('double click, then keys in the same tick: they wait for the editor and land in it', async () => {
    activate(0, 3);
    // Glide focuses the grid a frame after the click; the editor is not there yet.
    gridCell.focus();
    await userEvent.keyboard('xyz');
    mountEditor(0, 3);
    const input = await editorInput();
    expect(input).toHaveFocus();
    expect(input).toHaveValue('xyz');
    await userEvent.keyboard('!');
    expect(input).toHaveValue('xyz!');
  });

  it('double click without typing: the editor opens on the value, all of it selected', async () => {
    activate(0, 3);
    mountEditor(0, 3);
    const input = await editorInput();
    expect(input).toHaveFocus();
    expect(input).toHaveValue('old value');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'old value'.length]);
  });

  it('double click, then Backspace before the editor: the value is cleared', async () => {
    activate(0, 3);
    await userEvent.keyboard('{Backspace}');
    mountEditor(0, 3);
    expect(await editorInput()).toHaveValue('');
  });

  it('the grid takes the focus after the editor did: the keys still go to the editor', async () => {
    activate(0, 3);
    mountEditor(0, 3);
    const input = await editorInput();
    expect(input).toHaveFocus();
    // Glide's late frame focuses the grid's cell (QA S6 L15: frames 100 ms apart).
    gridCell.focus();
    await Promise.resolve();
    expect(input).toHaveFocus();
    await userEvent.keyboard('xyz');
    expect(input).toHaveValue('xyz');
  });

  it('Escape on another editor, then a double click and keys: all of them in the new editor', async () => {
    // Glide on Escape: the grid takes the focus at once, then editing is over.
    const onFinished = vi.fn(() => {
      gridCell.focus();
      typing.end();
    });
    activate(1, 3);
    const first = mountEditor(1, 3, onFinished);
    await editorInput();
    await userEvent.keyboard('{Escape}');
    expect(onFinished).toHaveBeenCalledTimes(1);
    first.unmount();
    await Promise.resolve();
    // Editing is over: the grid keeps the focus it took.
    expect(gridCell).toHaveFocus();

    activate(0, 3);
    gridCell.focus();
    await userEvent.keyboard('x');
    mountEditor(0, 3);
    const input = await editorInput();
    gridCell.focus();
    await userEvent.keyboard('yz');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('xyz');
  });

  it('typing on a cell (no editor yet) starts the editor with that key', async () => {
    typing.start({ host, col: 0, row: 3, first: 'Đ', place: PLACE, label: 'Title', onAbandon });
    await userEvent.keyboard('ơn');
    mountEditor(0, 3);
    const input = await editorInput();
    expect(input).toHaveValue('Đơn');
    gridCell.focus();
    await Promise.resolve();
    await userEvent.keyboard(' hàng');
    expect(input).toHaveValue('Đơn hàng');
  });

  it('IME: the editor arriving during a composition does not cut it', async () => {
    activate(0, 3);
    const sink = host.querySelector('textarea');
    if (sink === null) throw new Error('no sink');
    // Telex "Viet" → "Việt": the composition is still open when the editor mounts.
    fireEvent.compositionStart(sink, { data: '' });
    sink.value = 'Việ';
    fireEvent.input(sink, { isComposing: true });
    mountEditor(0, 3);
    await act(async () => {
      await Promise.resolve();
    });
    // The composition goes on where it started.
    expect(sink).toHaveFocus();
    sink.value = 'Việt';
    fireEvent.input(sink, { isComposing: true });
    fireEvent.compositionEnd(sink, { data: 'Việt' });
    const input = await editorInput();
    expect(input).toHaveValue('Việt');
    expect(input).toHaveFocus();
  });

  it('IME in the open editor: the grid taking the focus does not end the composition elsewhere', async () => {
    activate(0, 3);
    mountEditor(0, 3);
    const input = await editorInput();
    fireEvent.compositionStart(input, { data: '' });
    gridCell.focus();
    await Promise.resolve();
    expect(input).toHaveFocus();
  });
});
