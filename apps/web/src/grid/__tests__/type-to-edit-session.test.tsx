import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestI18n } from '../../../test/i18n';
import { createOverlayEditor, isEditCell } from '../editors/overlay';
import { TypeToEdit } from '../type-to-edit';
import { toGridField, type GridRecord } from '../types';

import type { EditorContext } from '../editors/types';
import type { FieldDto } from '@cellhive/contracts';
import type { GridCell, ProvideEditorComponent } from '@glideapps/glide-data-grid';
import type { i18n as I18n } from 'i18next';

/**
 * Type to edit (S3 QA): what is typed until the overlay editor has the
 * focus is kept, in order, and the editor starts from all of it.
 */

let host: HTMLElement;
let gridCell: HTMLElement;
let editorInput: HTMLInputElement;
let onAbandon: ReturnType<typeof vi.fn<() => void>>;
let typing: TypeToEdit;

const PLACE = { x: 10, y: 10, height: 34 };

function sink(): HTMLTextAreaElement {
  const element = host.querySelector('textarea');
  if (element === null) throw new Error('no sink');
  return element;
}

beforeEach(() => {
  host = document.createElement('section');
  gridCell = document.createElement('div');
  gridCell.tabIndex = 0;
  host.append(gridCell);
  editorInput = document.createElement('input');
  document.body.append(host, editorInput);
  onAbandon = vi.fn<() => void>();
  typing = new TypeToEdit();
});

afterEach(() => {
  typing.end();
  host.remove();
  editorInput.remove();
});

describe('TypeToEdit', () => {
  it('keeps every key typed until the editor takes the focus, spaces and diacritics included', async () => {
    typing.start({ host, col: 0, row: 3, first: 'X', place: PLACE, label: 'Title', onAbandon });
    expect(document.activeElement).toBe(sink());
    const typed = typing.inputFor(0, 3);
    expect(typing.inputFor(1, 3)).toBeUndefined();
    await userEvent.keyboard('in chào');
    expect(typed?.text()).toBe('Xin chào');
    expect(typing.isPending()).toBe(true);
    const settled = vi.fn();
    typed?.onSettle(settled);
    editorInput.focus();
    expect(settled).toHaveBeenCalledWith({
      cancelled: false,
      text: 'Xin chào',
      finishKey: undefined,
    });
    expect(typing.isPending()).toBe(false);
    expect(host.querySelector('textarea')).toBeNull();
    // The editor still reads the whole text (StrictMode renders it again).
    expect(typed?.text()).toBe('Xin chào');
  });

  it('adds characters that still reached the grid', () => {
    typing.start({ host, col: 0, row: 0, first: 'Đ', place: PLACE, label: 'Title', onAbandon });
    typing.append('ơ');
    typing.append('n');
    expect(typing.inputFor(0, 0)?.text()).toBe('Đơn');
  });

  it('takes the focus back when glide focuses the grid late', async () => {
    typing.start({ host, col: 0, row: 0, first: 'a', place: PLACE, label: 'Title', onAbandon });
    const box = sink();
    gridCell.focus();
    await Promise.resolve();
    expect(document.activeElement).toBe(box);
    expect(typing.isPending()).toBe(true);
  });

  it('remembers Enter and Tab for the editor instead of typing them', async () => {
    typing.start({ host, col: 0, row: 0, first: 'a', place: PLACE, label: 'Title', onAbandon });
    await userEvent.keyboard('b{Enter}');
    const typed = typing.inputFor(0, 0);
    editorInput.focus();
    expect(typed?.settled()).toEqual({
      cancelled: false,
      text: 'ab',
      finishKey: { key: 'Enter', shiftKey: false },
    });
  });

  it('Escape cancels and gives the keyboard back to the grid', async () => {
    typing.start({ host, col: 0, row: 0, first: 'a', place: PLACE, label: 'Title', onAbandon });
    const typed = typing.inputFor(0, 0);
    await userEvent.keyboard('{Escape}');
    expect(typed?.settled()).toEqual({ cancelled: true, text: undefined, finishKey: undefined });
    expect(onAbandon).toHaveBeenCalledTimes(1);
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('a click makes the text final; another cell drops it', () => {
    typing.start({ host, col: 0, row: 0, first: 'a', place: PLACE, label: 'Title', onAbandon });
    const first = typing.inputFor(0, 0);
    typing.release();
    expect(first?.settled()?.text).toBe('a');
    typing.start({ host, col: 0, row: 1, first: 'b', place: PLACE, label: 'Title', onAbandon });
    const second = typing.inputFor(0, 1);
    typing.cancel();
    expect(second?.settled()?.cancelled).toBe(true);
    expect(typing.inputFor(0, 1)).toBeUndefined();
  });

  it('gives up when no editor comes', () => {
    vi.useFakeTimers();
    try {
      typing.start({ host, col: 0, row: 0, first: 'a', place: PLACE, label: 'Title', onAbandon });
      vi.advanceTimersByTime(10_000);
      expect(typing.isPending()).toBe(false);
      expect(onAbandon).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('overlay editor opened by typing', () => {
  let i18n: I18n;
  beforeAll(async () => {
    i18n = await createTestI18n('en');
  });

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

  function mount(Editor: ProvideEditorComponent<GridCell>) {
    const onFinishedEditing = vi.fn();
    const props = {
      onChange: vi.fn(),
      onFinishedEditing,
      initialValue: undefined,
      target: { x: 0, y: 0, width: 200, height: 34 },
    } as unknown as Parameters<ProvideEditorComponent<GridCell>>[0];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <Editor {...props} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    return onFinishedEditing;
  }

  it('starts from everything typed before it had the focus, then writes it on an early Enter', async () => {
    typing.start({ host, col: 0, row: 0, first: 'X', place: PLACE, label: 'Title', onAbandon });
    await userEvent.keyboard('in chào{Enter}');
    const Editor = createOverlayEditor(toGridField(field), record, context, typing.inputFor(0, 0));
    if (Editor === undefined) throw new Error('no editor');
    const finished = mount(Editor);
    await act(async () => {
      await Promise.resolve();
    });
    expect(finished).toHaveBeenCalledTimes(1);
    const [cell] = finished.mock.calls[0] as [GridCell];
    if (!isEditCell(cell)) throw new Error('not an edit cell');
    expect(cell.data.draft).toMatchObject({ ok: true, commit: { value: 'Xin chào' } });
  });

  it('keeps what was typed while it mounted, without an early Enter', async () => {
    typing.start({ host, col: 0, row: 0, first: 'Q', place: PLACE, label: 'Title', onAbandon });
    await userEvent.keyboard('A S3');
    const Editor = createOverlayEditor(toGridField(field), record, context, typing.inputFor(0, 0));
    if (Editor === undefined) throw new Error('no editor');
    const finished = mount(Editor);
    const input = await screen.findByRole('textbox', { name: 'Title' });
    expect(input).toHaveValue('QA S3');
    expect(input).toHaveFocus();
    await userEvent.keyboard(' Tiếng Việt');
    expect(input).toHaveValue('QA S3 Tiếng Việt');
    expect(finished).not.toHaveBeenCalled();
  });
});
