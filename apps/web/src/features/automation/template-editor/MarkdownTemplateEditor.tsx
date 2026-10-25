import { Button, cn, Tooltip } from '@cellhive/ui';
import {
  Bold,
  Braces,
  Italic,
  Link,
  List,
  ListOrdered,
  Minus,
  Plus,
  Quote,
  Strikethrough,
  Table,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  TemplateInput,
  type TemplateEditorHandle,
  type TemplateInputProps,
} from '../builder/components/values/TemplateInput';

import {
  commandOfShortcut,
  MARKDOWN_COMMANDS,
  sourceLength,
  TOOLBAR_GROUPS,
  type MarkdownCommandId,
} from './markdown-commands';

const ICONS: Record<MarkdownCommandId, LucideIcon> = {
  bold: Bold,
  italic: Italic,
  strike: Strikethrough,
  link: Link,
  bullet: List,
  numbered: ListOrdered,
  quote: Quote,
  rule: Minus,
  table: Table,
};

const INSERT_VALUE = 'insert-value';
const FORMULA = 'formula';
const IMAGE = 'image';

/** What the toolbar hands its "Insert image" button (T534). */
export interface ImageButtonProps {
  /** Puts a line of Markdown (`![alt](asset:att_…)`, `![alt](field:fld_…)`) at the caret. */
  readonly onInsert: (markdown: string) => void;
  /** Roving tab stop of the toolbar. */
  readonly tabIndex: number;
  /** `data-tool` of the button (its key in the toolbar). */
  readonly toolId: string;
}

/** Shortcut shown in a button's name ("Bold (Ctrl+B)"). */
const SHORTCUT_LABELS: Partial<Record<MarkdownCommandId, string>> = {
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  link: 'Ctrl+K',
};

export interface MarkdownTemplateEditorProps extends Pick<
  TemplateInputProps,
  'value' | 'onChange' | 'chipLabel' | 'sections' | 'invalid' | 'describedBy' | 'testId'
> {
  /** Id of the visible label of the editor. */
  readonly labelId: string;
  readonly label: string;
  /** Opens the formula expression dialog; `insert` puts its chip at the caret. */
  readonly onExpression: (insert: (expression: string) => void) => void;
  readonly maxLength: number;
  /** Hidden commands (e.g. the table when there is no `digest`). */
  readonly hide?: readonly MarkdownCommandId[];
  /**
   * "Insert image" (T534): the button that inserts the Markdown of an email
   * image at the caret through `onInsert` (`send_email`:
   * `actions/send-email/image-hook.tsx`). `null`: no button.
   */
  readonly ImageButton?: ComponentType<ImageButtonProps> | null;
  /** More tools at the end of the toolbar (e.g. the `digest` table). */
  readonly extraTools?: ReactNode;
}

/**
 * The narrow Markdown template editor (T522; board "S5 · Email template
 * editor", ADR-32 §3): a toolbar that inserts Markdown syntax (bold,
 * italic, strike, link, lists, quote, rule, table — never HTML), the chip
 * editor of the builder (placeholders by name, stored with ids; `{{` or
 * "Insert value" opens the value menu), "Formula" for an expression, and
 * the length of the source. The toolbar is one tab stop (←/→ move inside).
 */
export function MarkdownTemplateEditor({
  value,
  onChange,
  chipLabel,
  sections,
  invalid,
  describedBy,
  testId,
  labelId,
  label,
  onExpression,
  maxLength,
  hide = [],
  ImageButton = null,
  extraTools,
}: MarkdownTemplateEditorProps) {
  const { t, i18n } = useTranslation('automationEmail');
  const editor = useRef<TemplateEditorHandle>(null);
  const [active, setActive] = useState<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);

  const insertImage = useCallback((markdown: string) => {
    editor.current?.insertBlock(markdown);
  }, []);

  const run = (id: MarkdownCommandId) => {
    const command = MARKDOWN_COMMANDS[id];
    if (command.kind === 'wrap') {
      editor.current?.wrap(
        command.before,
        command.after,
        t(command.fallback === 'linkText' ? 'editor.linkText' : 'editor.text'),
      );
    } else {
      editor.current?.insertBlock(command.text);
    }
  };

  const onToolbarKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
      if (event.key === 'Home' || event.key === 'End') event.preventDefault();
      else return;
    }
    const buttons = [
      ...(toolbar.current?.querySelectorAll<HTMLButtonElement>(
        'button[data-tool]:not([disabled])',
      ) ?? []),
    ];
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % buttons.length
        : event.key === 'ArrowLeft'
          ? (current - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : buttons.length - 1;
    setActive(buttons[next]?.dataset['tool'] ?? null);
    buttons[next]?.focus();
  };

  // Roving tab stop: only the active button of the toolbar is in the tab order.
  const first = TOOLBAR_GROUPS.flat().find((id) => !hide.includes(id)) ?? INSERT_VALUE;
  const tabIndexOf = (key: string) => (key === (active ?? first) ? 0 : -1);
  const keepCaret = (event: React.MouseEvent) => {
    // The caret of the text stays where the syntax goes.
    event.preventDefault();
  };

  const length = sourceLength(value);
  const format = new Intl.NumberFormat(i18n.language);
  return (
    <div
      className={cn(
        'flex flex-col rounded-md border border-line-control bg-surface',
        invalid === true && 'border-danger',
      )}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
        const id = commandOfShortcut(event.key);
        if (id === null || (event.target as HTMLElement).getAttribute('role') !== 'textbox') return;
        event.preventDefault();
        run(id);
      }}
    >
      <div
        ref={toolbar}
        role="toolbar"
        aria-label={t('editor.toolbar')}
        className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1"
        onKeyDown={onToolbarKey}
      >
        {TOOLBAR_GROUPS.map((group, groupIndex) => (
          <div key={group.join('-')} className="flex items-center gap-0.5">
            {groupIndex === 0 ? null : (
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-line" />
            )}
            {group
              .filter((id) => !hide.includes(id))
              .map((id) => {
                const Icon = ICONS[id];
                const shortcut = SHORTCUT_LABELS[id];
                const name =
                  shortcut === undefined
                    ? t(`editor.commands.${id}`)
                    : t('editor.withShortcut', {
                        name: t(`editor.commands.${id}`),
                        shortcut,
                      });
                return (
                  <Tooltip key={id} content={name}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 max-lg:size-control"
                      aria-label={name}
                      tabIndex={tabIndexOf(id)}
                      data-tool={id}
                      data-testid={`md-${id}`}
                      onMouseDown={keepCaret}
                      onClick={() => {
                        run(id);
                      }}
                    >
                      <Icon aria-hidden="true" />
                    </Button>
                  </Tooltip>
                );
              })}
          </div>
        ))}
        {ImageButton === null ? null : (
          <ImageButton onInsert={insertImage} tabIndex={tabIndexOf(IMAGE)} toolId={IMAGE} />
        )}
        <span className="ml-auto flex items-center gap-0.5">
          {extraTools}
          <Button
            variant="ghost"
            size="sm"
            className="max-lg:h-control"
            tabIndex={tabIndexOf(INSERT_VALUE)}
            data-tool={INSERT_VALUE}
            data-testid="md-insert-value"
            onMouseDown={keepCaret}
            onClick={() => {
              editor.current?.openPicker();
            }}
          >
            <Plus aria-hidden="true" />
            {t('editor.insertValue')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="max-lg:h-control"
            tabIndex={tabIndexOf(FORMULA)}
            data-tool={FORMULA}
            data-testid="md-formula"
            onMouseDown={keepCaret}
            onClick={() => {
              onExpression((expression) => {
                editor.current?.insertExpression(expression);
              });
            }}
          >
            <Braces aria-hidden="true" />
            {t('editor.formula')}
          </Button>
        </span>
      </div>
      <div className="[&_[role=textbox]]:min-h-56 [&_[role=textbox]]:rounded-none [&_[role=textbox]]:border-0">
        <TemplateInput
          value={value}
          onChange={onChange}
          chipLabel={chipLabel}
          sections={sections}
          label={label}
          multiline
          hidePlus
          invalid={invalid}
          describedBy={describedBy}
          testId={testId}
          editorRef={editor}
        />
      </div>
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-label font-normal text-fg-muted"
        id={`${labelId}-meta`}
      >
        <span>{t('editor.hint', { open: '{{' })}</span>
        <span
          className={cn('tabular-nums', length > maxLength && 'text-danger')}
          data-testid="md-length"
        >
          {t('editor.length', { length: format.format(length), max: format.format(maxLength) })}
        </span>
      </div>
    </div>
  );
}
