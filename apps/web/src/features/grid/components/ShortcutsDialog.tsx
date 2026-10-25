import { Dialog } from '@cellhive/ui';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import { isApplePlatform } from '../../../grid/undo/keys';

/** A key of a combination: `mod` is ⌘ on Apple platforms and Ctrl elsewhere. */
type Key =
  | 'mod'
  | 'ctrl'
  | 'shift'
  | 'enter'
  | 'esc'
  | 'tab'
  | 'space'
  | 'delete'
  | 'backspace'
  | 'arrows'
  | 'f2'
  | 'f10'
  | 'c'
  | 'x'
  | 'v'
  | 'd'
  | 'z'
  | 'y'
  | 'f'
  | 's'
  | 'question'
  | 'alt'
  | 'left'
  | 'right'
  | 'bracketLeft'
  | 'bracketRight';

/** FRONTEND §6.2, in the order of the spec. */
const SHORTCUTS: readonly { action: string; combos: readonly (readonly Key[])[] }[] = [
  { action: 'move', combos: [['arrows'], ['tab'], ['shift', 'tab']] },
  { action: 'edit', combos: [['enter'], ['f2']] },
  { action: 'cancel', combos: [['esc']] },
  { action: 'clear', combos: [['delete'], ['backspace']] },
  { action: 'copy', combos: [['mod', 'c']] },
  { action: 'cut', combos: [['mod', 'x']] },
  { action: 'paste', combos: [['mod', 'v']] },
  { action: 'fillDown', combos: [['mod', 'd']] },
  { action: 'undo', combos: [['mod', 'z']] },
  {
    action: 'redo',
    combos: [
      ['shift', 'mod', 'z'],
      ['ctrl', 'y'],
    ],
  },
  { action: 'openRecord', combos: [['space']] },
  { action: 'selectRow', combos: [['shift', 'space']] },
  { action: 'search', combos: [['mod', 'f']] },
  { action: 'saveView', combos: [['mod', 's']] },
  { action: 'addBelow', combos: [['shift', 'enter']] },
  { action: 'addRecord', combos: [['mod', 'shift', 'enter']] },
  { action: 'groupHeader', combos: [['enter'], ['space'], ['shift', 'f10']] },
  // T417: sub-record trees (BACKLOG S4 design decision 3; Tab keeps moving between cells).
  { action: 'treeToggle', combos: [['right'], ['left']] },
  {
    action: 'treeIndent',
    combos: [
      ['mod', 'bracketRight'],
      ['alt', 'shift', 'right'],
    ],
  },
  {
    action: 'treeOutdent',
    combos: [
      ['mod', 'bracketLeft'],
      ['alt', 'shift', 'left'],
    ],
  },
  { action: 'help', combos: [['question']] },
];

const LETTERS: Partial<Record<Key, string>> = {
  c: 'C',
  x: 'X',
  v: 'V',
  d: 'D',
  z: 'Z',
  y: 'Y',
  f: 'F',
  s: 'S',
  question: '?',
  left: '←',
  right: '→',
  bracketLeft: '[',
  bracketRight: ']',
};

export interface ShortcutsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The keyboard shortcuts of the grid (`?`, FRONTEND §6.2): ⌘ on macOS, Ctrl elsewhere. */
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  const { t } = useTranslation('grid');
  const apple = isApplePlatform();
  const label = (key: Key): string => {
    if (key === 'mod') return apple ? '⌘' : t('shortcuts.keys.ctrl');
    if (key === 'alt') return apple ? '⌥' : t('shortcuts.keys.alt');
    return LETTERS[key] ?? t(`shortcuts.keys.${key}`);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('shortcuts.title')}
      closeLabel={t('shortcuts.close')}
      className="max-w-3xl"
    >
      {/* Scrolls when the list is taller than the window: reachable with the keyboard. */}
      <div
        role="region"
        aria-label={t('shortcuts.title')}
        tabIndex={0}
        className="max-h-[60dvh] overflow-y-auto"
      >
        <table className="w-full border-collapse text-body">
          <thead className="sr-only">
            <tr>
              <th scope="col">{t('shortcuts.action')}</th>
              <th scope="col">{t('shortcuts.keysHeading')}</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(({ action, combos }) => (
              <tr key={action} className="border-b border-line last:border-b-0">
                {/* One line per action from 640 px (T322b); the key column takes what is left. */}
                <th scope="row" className="py-2 pr-6 text-left font-normal sm:whitespace-nowrap">
                  {t(`shortcuts.actions.${action}`)}
                </th>
                {/* Keys wrap between combinations when the row is short of room. */}
                <td className="w-full py-2 text-right">
                  {combos.map((combo, index) => (
                    <Fragment key={combo.join('+')}>
                      {index > 0 ? (
                        <span className="px-2 text-label font-normal text-fg-muted">
                          {t('shortcuts.or')}
                        </span>
                      ) : null}
                      {/* A combination (outer kbd) of keys: only the keys are drawn as keys. */}
                      <kbd className="inline-flex items-center gap-1 font-sans text-body whitespace-nowrap">
                        {combo.map((key) => (
                          <kbd
                            key={key}
                            className="inline-flex h-6 min-w-6 items-center justify-center rounded-sm border border-line-strong bg-surface-sunken px-2 font-sans text-label font-medium text-fg"
                          >
                            {label(key)}
                          </kbd>
                        ))}
                      </kbd>
                    </Fragment>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
