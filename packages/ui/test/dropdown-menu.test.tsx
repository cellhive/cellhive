import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../src/index';

function Harness() {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Undo</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button">Grid</button>
    </>
  );
}

async function openThenEscape(): Promise<HTMLElement> {
  const trigger = screen.getByRole('button', { name: 'More' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  fireEvent.keyDown(menu, { key: 'Escape' });
  return trigger;
}

/** One task later: when Radix hands the focus back after the menu unmounted. */
const nextTask = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

describe('DropdownMenuContent focus on close (T420)', () => {
  it('gives the focus back to the trigger after Escape', async () => {
    render(<Harness />);
    const trigger = await openThenEscape();
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    await nextTask();
    expect(trigger).toHaveFocus();
  });

  it('leaves the focus where a click put it right after Escape', async () => {
    render(<Harness />);
    await openThenEscape();
    // The click on the grid lands before Radix's focus return.
    screen.getByRole('button', { name: 'Grid' }).focus();
    await nextTask();
    await nextTask();
    expect(screen.getByRole('button', { name: 'Grid' })).toHaveFocus();
  });
});
