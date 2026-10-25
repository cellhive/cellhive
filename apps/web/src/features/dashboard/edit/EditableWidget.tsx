import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
} from '@cellhive/ui';
import { Copy, GripVertical, MoreHorizontal, Move, Scaling, Settings2, Trash2 } from 'lucide-react';
import { useId, useRef, type KeyboardEvent, type Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { WidgetCard } from '../widgets/WidgetCard';

import type { WidgetDataContext } from '../api';
import type { EditorWidget } from './editor-session';
import type { WidgetDto } from '@cellhive/contracts';

/** The class react-grid-layout drags by (the grip in the header). */
export const DRAG_HANDLE_CLASS = 'dashboard-drag-handle';

export type KeyboardMode = 'move' | 'resize';

/** A widget of the editor as the view's card needs it. */
export function widgetDtoOf(widget: EditorWidget, dashboardId: string): WidgetDto {
  return {
    id: (widget.id ?? widget.key) as WidgetDto['id'],
    dashboard_id: dashboardId as WidgetDto['dashboard_id'],
    type: widget.type,
    title: widget.title,
    config: widget.config,
    layout: widget.layout,
    status: widget.status,
    broken_reason: widget.broken_reason,
    created_at: widget.created_at,
    updated_at: widget.updated_at,
  };
}

export interface EditableWidgetProps {
  readonly widget: EditorWidget;
  readonly dashboardId: string;
  readonly context: WidgetDataContext;
  /** The 12-column grid is on screen: widgets can be moved and resized. */
  readonly arrangeable: boolean;
  readonly canAdd: boolean;
  /** Being moved or resized with the keyboard. */
  readonly keyboardMode: KeyboardMode | null;
  readonly sectionRef: Ref<HTMLElement>;
  readonly onConfigure: () => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
  readonly onKeyboardStart: (mode: KeyboardMode) => void;
  readonly onKeyboardKey: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onKeyboardBlur: () => void;
}

/**
 * One widget in edit mode (T812): the view's card with a drag grip and an
 * actions menu — settings, move and resize with the keyboard (S7 decision
 * #19), duplicate, delete. While moved with the keyboard the card shows the
 * keys to use (and is described by them).
 */
export function EditableWidget({
  widget,
  dashboardId,
  context,
  arrangeable,
  canAdd,
  keyboardMode,
  sectionRef,
  onConfigure,
  onDuplicate,
  onRemove,
  onKeyboardStart,
  onKeyboardKey,
  onKeyboardBlur,
}: EditableWidgetProps) {
  const { t } = useTranslation('dashboard');
  const hintId = useId();
  /** A menu item that hands the focus to the card itself (keyboard moves). */
  const focusCard = useRef(false);
  const name = widget.title.trim() === '' ? t(`type.${widget.type}`) : widget.title;

  const actions = (
    <div className="-mt-1 -mr-2 flex shrink-0 items-center">
      {arrangeable ? (
        <span
          aria-hidden="true"
          className={`${DRAG_HANDLE_CLASS} flex size-7 cursor-grab items-center justify-center rounded-sm text-fg-muted hover:bg-surface-sunken active:cursor-grabbing`}
          data-testid="widget-drag-handle"
        >
          <GripVertical className="size-4" />
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 max-lg:size-control"
            aria-label={t('edit.widget.actions', { name })}
            data-testid="widget-actions"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (!focusCard.current) return;
            focusCard.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuItem onSelect={onConfigure}>
            <Settings2 aria-hidden="true" />
            {t('edit.widget.settings')}
          </DropdownMenuItem>
          {arrangeable ? (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  focusCard.current = true;
                  onKeyboardStart('move');
                }}
              >
                <Move aria-hidden="true" />
                {t('edit.widget.move')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  focusCard.current = true;
                  onKeyboardStart('resize');
                }}
              >
                <Scaling aria-hidden="true" />
                {t('edit.widget.resize')}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem disabled={!canAdd} onSelect={onDuplicate}>
            <Copy aria-hidden="true" />
            {t('edit.widget.duplicate')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRemove} className="text-danger [&_svg]:text-danger">
            <Trash2 aria-hidden="true" />
            {t('edit.widget.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="relative flex size-full min-h-0 flex-col">
      {widget.id === null ? (
        <section
          ref={sectionRef}
          tabIndex={0}
          aria-label={name}
          aria-busy="true"
          data-testid={`widget-pending-${widget.key}`}
          className="flex size-full min-h-0 flex-col gap-2 rounded-lg border border-dashed border-line-strong bg-surface p-4 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <p className="text-heading font-semibold text-fg">{name}</p>
          <p className="text-label font-normal text-fg-muted">{t('edit.widget.adding')}</p>
          <Skeleton className="min-h-0 flex-1" aria-hidden="true" />
        </section>
      ) : (
        <WidgetCard
          widget={widgetDtoOf(widget, dashboardId)}
          context={context}
          admin
          frame={{
            actions,
            ref: sectionRef,
            active: keyboardMode !== null,
            describedBy: keyboardMode === null ? undefined : hintId,
            onKeyDown: (event) => {
              if (keyboardMode !== null && event.target === event.currentTarget) {
                onKeyboardKey(event);
              }
            },
            onBlur: (event) => {
              if (keyboardMode === null) return;
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              onKeyboardBlur();
            },
          }}
        />
      )}
      {keyboardMode === null ? null : (
        <p
          id={hintId}
          className="absolute inset-x-2 bottom-2 rounded-md bg-inverse px-3 py-2 text-label font-normal text-on-inverse shadow-popover"
          data-testid="widget-keyboard-hint"
        >
          {t(keyboardMode === 'move' ? 'edit.keyboard.moveHint' : 'edit.keyboard.resizeHint')}
        </p>
      )}
    </div>
  );
}
