import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@cellhive/ui';
import { useDraggable } from '@dnd-kit/core';
import { Ellipsis, Info, Maximize2 } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { CellValue } from '../../../grid/display/CellValue';
import { imageSourceOf } from '../../../lib/attachments/kinds';
import { useRetryingImage } from '../../../lib/attachments/use-retrying-image';
import { cellFilesOf } from '../../../lib/attachments/value';

import type { GridField } from '../../../grid/types';
import type { KanbanColumnDef } from '../board';
import type { MoveBlock } from '../use-kanban-editing';
import type { RecordDto } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

/**
 * Card geometry, px (4 px grid, T322b). A card is as tall as its content;
 * {@link cardHeight} is the tallest a card can be, the estimate of the
 * column's windowing until the card is measured.
 */
const CARD_CHROME = 26; // padding 12 + 12, border 1 + 1
const CODE_LINE = 16;
const TITLE_LINES = 2;
const TITLE_LINE = 18;
const VALUE_ROW = 22;
const SECTION_GAP = 8;
const ROW_GAP = 4;
/** Values shown per row of a card (they wrap; more than fits is clipped). */
const VALUES_PER_ROW = 3;
/** At most this many rows of values. */
const MAX_VALUE_ROWS = 3;
/** Space between two cards, px. */
export const CARD_GAP = 8;
/** Cover image of a card (T418, `cover_field`, F§6.6): full width, this tall, then a gap. */
export const COVER_HEIGHT = 120;
const COVER_GAP = 12;

/**
 * A code of the record (`auto_number`, a `barcode` text): shown small and
 * monospaced above the title, as on the design (FRONTEND §9.3).
 */
export function isCodeField(field: GridField): boolean {
  if (field.field.type === 'auto_number') return true;
  return field.config?.type === 'text' && field.config.options.style.type === 'barcode';
}

/** The card fields split into the code line (first code field) and the values. */
export function cardLayout(cardFields: readonly GridField[]): {
  readonly code: GridField | undefined;
  readonly values: readonly GridField[];
} {
  const code = cardFields.find(isCodeField);
  return { code, values: cardFields.filter((field) => field !== code) };
}

function valueRows(count: number): number {
  return Math.min(MAX_VALUE_ROWS, Math.ceil(count / VALUES_PER_ROW));
}

/** Tallest card showing `cardFields` (cover image, code line, two title lines, rows of values). */
export function cardHeight(cardFields: readonly GridField[], cover = false): number {
  const { code, values } = cardLayout(cardFields);
  const rows = valueRows(values.length);
  return (
    CARD_CHROME +
    (cover ? COVER_HEIGHT + COVER_GAP - 12 : 0) +
    (code === undefined ? 0 : CODE_LINE + ROW_GAP) +
    TITLE_LINES * TITLE_LINE +
    (rows === 0 ? 0 : SECTION_GAP + rows * VALUE_ROW + (rows - 1) * ROW_GAP)
  );
}

/** The cover of the cards (`kanban.cover_field`, T418): an attachment field and whether its images load. */
export interface CardCover {
  readonly field: GridField;
  /**
   * `file_download_fields` (CONTRACTS §5A): without it the cover still shows
   * through the thumbnail (T407), never through the file itself.
   */
  readonly canView: boolean;
}

export interface CardBodyProps {
  readonly record: RecordDto;
  readonly primary: GridField | undefined;
  readonly cardFields: readonly GridField[];
  readonly locale: LocaleContext;
  readonly cover?: CardCover | null | undefined;
}

/**
 * The first image of the cover field through its thumbnail (T407, 256 px),
 * loaded lazily so the first cards never wait for it (FRONTEND §11.1). A
 * record without an image has no cover; one that cannot load (no thumbnail
 * yet for a user who may not download) is hidden.
 */
function CardCoverImage({ record, cover }: { record: RecordDto; cover: CardCover }) {
  const image = cellFilesOf(record.fields[cover.field.field.id]).find(
    (file) => imageSourceOf(file, cover.canView) !== null,
  );
  // A thumbnail not rendered yet is asked again with backoff (T421b); the box keeps its room.
  const loaded = useRetryingImage(image === undefined ? null : imageSourceOf(image, cover.canView));
  if (loaded.failed) return null;
  return (
    <span
      className="-mx-3 -mt-3 mb-3 block overflow-hidden bg-surface-sunken"
      style={{ height: COVER_HEIGHT }}
      data-testid="kanban-card-cover"
    >
      {loaded.src === null ? null : (
        <img
          src={loaded.src}
          alt=""
          onError={loaded.onError}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="block w-full object-cover"
          style={{ height: COVER_HEIGHT }}
        />
      )}
    </span>
  );
}

/**
 * The card (design "Kanban", Lark): the record's code in mono, the title
 * (primary field) on up to two lines, then the card fields as bare values —
 * chips, avatars, dates — without labels (their names are read out to
 * screen readers and shown on hover). Empty values take no room.
 */
export function CardBody({ record, primary, cardFields, locale, cover }: CardBodyProps) {
  const { t } = useTranslation('kanban');
  const { code, values } = cardLayout(cardFields);
  // Empty values take no room; no row at all when every value is empty.
  const filled = values.filter((field) => {
    const value = record.fields[field.field.id];
    if (value === null || value === undefined || value === '') return false;
    return !(Array.isArray(value) && value.length === 0);
  });
  const rows = valueRows(filled.length);
  const codeValue = code === undefined ? undefined : record.fields[code.field.id];
  return (
    <>
      {cover === null || cover === undefined ? null : (
        <CardCoverImage record={record} cover={cover} />
      )}
      {code === undefined ? null : (
        <span
          className="flex h-4 min-w-0 items-center font-mono text-mono text-fg-muted"
          title={code.field.name}
        >
          <span className="sr-only">{`${code.field.name}: `}</span>
          <CellValue
            links={false}
            field={code}
            value={codeValue}
            locale={locale}
            empty={<span className="text-fg-subtle">—</span>}
            compact
          />
        </span>
      )}
      <span
        className={cn(
          // As tall as the title: one line or two (no gap under a short title, T322b).
          'line-clamp-2 min-w-0 leading-[18px] font-medium break-words',
          code !== undefined && 'mt-1',
        )}
        data-testid="kanban-card-title"
      >
        {primary === undefined ? (
          <span className="text-fg-muted">{t('card.untitled')}</span>
        ) : (
          <CellValue
            links={false}
            field={primary}
            value={record.fields[primary.field.id]}
            locale={locale}
            empty={<span className="text-fg-muted">{t('card.untitled')}</span>}
            className="whitespace-normal"
          />
        )}
      </span>
      {rows === 0 ? null : (
        <span
          className="mt-2 flex min-w-0 flex-wrap content-start items-center gap-x-2 gap-y-1 overflow-hidden text-label font-normal"
          // At most MAX_VALUE_ROWS rows; what does not fit is clipped.
          style={{ maxHeight: MAX_VALUE_ROWS * VALUE_ROW + (MAX_VALUE_ROWS - 1) * ROW_GAP }}
        >
          {filled.map((field) => {
            const value = record.fields[field.field.id];
            return (
              <span
                key={field.field.id}
                className="flex h-[22px] max-w-full min-w-0 items-center"
                title={field.field.name}
                data-testid="kanban-card-value"
              >
                <span className="sr-only">{`${field.field.name}: `}</span>
                <CellValue field={field} value={value} locale={locale} compact links={false} />
              </span>
            );
          })}
        </span>
      )}
    </>
  );
}

export interface KanbanCardProps extends CardBodyProps {
  readonly column: KanbanColumnDef;
  /** Columns a card can be moved to ("Move to…", the keyboard path of dragging). */
  readonly columns: readonly KanbanColumnDef[];
  readonly columnName: (column: KanbanColumnDef) => string;
  readonly draggable: boolean;
  /** Why cards cannot be moved here (shown in the card menu), when {@link draggable} is off. */
  readonly moveBlocked?: MoveBlock | null | undefined;
  /** A move of this card is on its way. */
  readonly moving: boolean;
  readonly onOpen: (recordId: string) => void;
  readonly onMove: (recordId: string, to: KanbanColumnDef) => void;
  /** Arrow up/down: focus the card before/after (`-1`/`1`). */
  readonly onStep: (recordId: string, step: -1 | 1) => void;
  /** "Follow" / "Unfollow" item of the card menu (T553), built when the menu opens. */
  readonly followItem?: ((recordId: string) => ReactNode) | undefined;
}

/**
 * A card: a button opening the record (click, Enter) that can be dragged
 * to another column (pointer, or Space then ←/→ then Space: dnd-kit's
 * keyboard sensor) and has a menu (Shift+F10 or the menu key on the card,
 * or its "…" button): open, follow or unfollow (T553), and "Move to" every column — "Uncategorized"
 * included, the current one checked — or why cards cannot be moved.
 */
export function KanbanCard({
  record,
  primary,
  cardFields,
  locale,
  cover,
  column,
  columns,
  columnName,
  draggable,
  moveBlocked = null,
  moving,
  onOpen,
  onMove,
  onStep,
  followItem,
}: KanbanCardProps) {
  const { t } = useTranslation('kanban');
  const [menuOpen, setMenuOpen] = useState(false);
  // A move from the menu hands the focus to a neighbour card (the column does it).
  const movedFromMenu = useRef(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: record.id,
    disabled: !draggable,
    data: { column: column.key },
    attributes: { roleDescription: t('card.roleDescription') },
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && !event.repeat) {
      event.preventDefault();
      onOpen(record.id);
      return;
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      setMenuOpen(true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      onStep(record.id, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    // Space picks the card up (keyboard sensor).
    listeners?.['onKeyDown']?.(event);
  };

  return (
    <div className="group relative">
      <div
        ref={setNodeRef}
        {...(draggable ? attributes : { role: 'button', tabIndex: 0 })}
        {...(draggable ? listeners : {})}
        data-card-id={record.id}
        data-testid="kanban-card"
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          // The card's own menu instead of the browser's (right click, Shift+F10).
          event.preventDefault();
          setMenuOpen(true);
        }}
        onClick={() => {
          onOpen(record.id);
        }}
        className={cn(
          'flex cursor-pointer flex-col overflow-hidden rounded-lg border border-line bg-surface p-3 text-left text-body',
          'hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
          draggable && 'touch-none',
          isDragging && 'opacity-40',
          moving && 'border-dashed border-accent',
        )}
      >
        <CardBody
          record={record}
          primary={primary}
          cardFields={cardFields}
          locale={locale}
          cover={cover}
        />
      </div>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip content={t('card.actions')} side="top">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              tabIndex={-1}
              aria-label={t('card.actions')}
              className={cn(
                'absolute top-2 right-2 size-6 bg-surface opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
                menuOpen && 'opacity-100',
              )}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          className="max-w-72"
          data-testid="kanban-card-menu"
          onCloseAutoFocus={(event) => {
            if (movedFromMenu.current) {
              // The card left the column: focus goes to a neighbour, not to the menu button.
              movedFromMenu.current = false;
              event.preventDefault();
              return;
            }
            // Back to the card itself (the "…" button is not in the tab order).
            event.preventDefault();
            document.querySelector<HTMLElement>(`[data-card-id="${record.id}"]`)?.focus();
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              onOpen(record.id);
            }}
          >
            <Maximize2 aria-hidden="true" />
            {t('card.open')}
          </DropdownMenuItem>
          {menuOpen ? followItem?.(record.id) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('card.moveTo')}</DropdownMenuLabel>
          {draggable ? (
            <DropdownMenuRadioGroup
              value={column.key}
              onValueChange={(key) => {
                const target = columns.find((item) => item.key === key);
                if (target === undefined || target.key === column.key) return;
                movedFromMenu.current = true;
                onMove(record.id, target);
              }}
            >
              {columns.map((target) => (
                <DropdownMenuRadioItem
                  key={target.key}
                  value={target.key}
                  data-testid="kanban-move-target"
                >
                  <span className="truncate">{columnName(target)}</span>
                  {target.key === column.key ? (
                    <span className="ml-auto pl-2 text-label font-normal text-fg-muted">
                      {t('card.current')}
                    </span>
                  ) : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          ) : (
            <DropdownMenuItem disabled data-testid="kanban-move-blocked">
              <Info aria-hidden="true" />
              <span className="whitespace-normal">
                {t(`card.moveBlocked.${moveBlocked ?? 'readOnly'}`)}
              </span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
