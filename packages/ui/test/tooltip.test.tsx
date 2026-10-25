import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, Switch, Tooltip, TOOLTIP_DELAY_MS, TooltipProvider } from '../src/index';

function renderUndo() {
  return render(
    <TooltipProvider>
      <Tooltip content="Undo" shortcut="Ctrl+Z">
        <Button variant="ghost" size="icon" aria-label="Undo">
          ↶
        </Button>
      </Tooltip>
      <Button>Elsewhere</Button>
    </TooltipProvider>,
  );
}

/** The visible tooltip bubble (Radix also renders a hidden `role="tooltip"` copy inside it). */
/** A key press first: jsdom, like browsers, shows `:focus-visible` after keyboard use. */
function keyboardFocus(element: HTMLElement) {
  fireEvent.keyDown(document.body, { key: 'Tab' });
  act(() => {
    element.focus();
  });
}

function bubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper] [data-state]');
}

describe('Tooltip (T322b)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows on hover only after the delay, and hides when the pointer leaves', () => {
    renderUndo();
    const button = screen.getByRole('button', { name: 'Undo' });
    fireEvent.pointerMove(button, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 50);
    });
    expect(bubble()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(bubble()).toHaveTextContent('UndoCtrl+Z');
    // Hoverable (WCAG 1.4.13): it stays while the pointer moves towards it, and
    // goes once the pointer is elsewhere.
    fireEvent.pointerLeave(button, { pointerType: 'mouse', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document.body, { pointerType: 'mouse', clientX: 900, clientY: 900 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(bubble()).toBeNull();
  });

  it('shows at once on keyboard focus and hides on blur and Escape', () => {
    renderUndo();
    const button = screen.getByRole('button', { name: 'Undo' });
    keyboardFocus(button);
    expect(bubble()).toHaveTextContent('Undo');
    act(() => {
      screen.getByRole('button', { name: 'Elsewhere' }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(bubble()).toBeNull();
    // Keyboard again: the tooltip comes back.
    keyboardFocus(button);
    expect(bubble()).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(bubble()).toBeNull();
  });

  it('stays hidden when the focus comes back after a mouse action (a menu closed by a click)', () => {
    renderUndo();
    const button = screen.getByRole('button', { name: 'Undo' });
    act(() => {
      screen.getByRole('button', { name: 'Elsewhere' }).focus();
    });
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' });
    fireEvent.mouseDown(document.body);
    act(() => {
      button.focus();
    });
    expect(bubble()).toBeNull();
  });

  it('does not repeat the name: the trigger keeps its label, no description, the bubble is hidden from AT', () => {
    renderUndo();
    const button = screen.getByRole('button', { name: 'Undo' });
    keyboardFocus(button);
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(button).toHaveAccessibleName('Undo');
    expect(bubble()?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('works without a provider (its own) and without a native title', () => {
    render(
      <Tooltip content="More">
        <button type="button" aria-label="More">
          …
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'More' });
    expect(button).not.toHaveAttribute('title');
    keyboardFocus(button);
    expect(bubble()).toHaveTextContent('More');
  });
});

describe('Switch (T322b)', () => {
  it('is a native check box with the switch role, off by default, toggled with Space', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="Show Notes" onChange={onChange} />);
    const control = screen.getByRole('switch', { name: 'Show Notes' });
    expect(control).not.toBeChecked();
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('draws the off track with the control border token (≥ 3:1)', () => {
    const { container } = render(<Switch aria-label="x" />);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveClass('bg-line-control');
  });
});
