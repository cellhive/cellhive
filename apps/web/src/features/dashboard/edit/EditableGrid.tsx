import { sortByPosition, MAX_WIDGET_HEIGHT, MIN_WIDGET_HEIGHT } from '@cellhive/contracts';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { GridLayout, useContainerWidth, verticalCompactor, type Layout } from 'react-grid-layout';
import { useTranslation } from 'react-i18next';

import { gridConfig, singleColumnHeight } from '../model/layout';
import { useWideLayout } from '../view/DashboardGrid';

import { DRAG_HANDLE_CLASS, EditableWidget, type KeyboardMode } from './EditableWidget';
import { arrowDirection, moveItem, resizeItem } from './grid-moves';

import type { WidgetDataContext } from '../api';
import type { DashboardEditorSession, EditorWidget, LayoutMap } from './editor-session';
import type { WidgetLayout } from '@cellhive/contracts';

interface KeyboardMove {
  readonly key: string;
  readonly mode: KeyboardMode;
  /** Places when the move started (Escape goes back to them). */
  readonly before: LayoutMap;
  /** DOM order kept while moving: the focused card is never re-inserted. */
  readonly order: readonly string[];
}

function orderOf(widgets: readonly EditorWidget[]): string[] {
  return sortByPosition(widgets.map((widget) => ({ id: widget.key, ...widget.layout }))).map(
    (item) => item.id,
  );
}

function mapOf(
  layout: Layout | readonly { id: string; x: number; y: number; w: number; h: number }[],
) {
  const map: Record<string, WidgetLayout> = {};
  for (const item of layout) {
    const id = 'i' in item ? item.i : item.id;
    map[id] = { x: item.x, y: item.y, w: item.w, h: item.h };
  }
  return map;
}

export interface EditableGridProps {
  readonly widgets: readonly EditorWidget[];
  readonly session: DashboardEditorSession;
  readonly dashboardId: string;
  readonly context: WidgetDataContext;
  readonly gap: number;
  readonly canAdd: boolean;
  readonly announce: (text: string) => void;
  readonly onConfigure: (key: string) => void;
  readonly onDuplicate: (key: string) => void;
  readonly onRemove: (key: string) => void;
}

/**
 * The widgets in edit mode (T812, SPEC §10.1): from 1024 px the 12-column
 * grid where widgets are dragged by their grip and resized by the corner
 * handle (react-grid-layout, vertical compaction like the server), or moved
 * and resized with the arrow keys from their menu (S7 decision #19: one
 * cell per key, the new place announced, Enter keeps it, Escape goes back).
 * Below 1024 px one column in reading order: settings, duplicate, delete.
 * The DOM order is the reading order, so Tab follows what is read.
 */
export function EditableGrid(props: EditableGridProps) {
  const { widgets, session, gap, announce } = props;
  const { t } = useTranslation('dashboard');
  const wide = useWideLayout();
  const [moving, setMoving] = useState<KeyboardMove | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const order = useMemo(
    () => (moving === null ? orderOf(widgets) : moving.order),
    [moving, widgets],
  );
  const byKey = useMemo(() => new Map(widgets.map((widget) => [widget.key, widget])), [widgets]);

  const focusLater = useCallback((key: string) => {
    window.requestAnimationFrame(() => {
      sections.current.get(key)?.focus();
    });
  }, []);

  const describe = useCallback(
    (key: string, mode: KeyboardMode, layout: WidgetLayout | undefined) => {
      if (layout === undefined) return;
      const name = byKey.get(key)?.title.trim() || t(`type.${byKey.get(key)?.type ?? 'text'}`);
      announce(
        mode === 'move'
          ? t('edit.keyboard.position', { name, column: layout.x + 1, row: layout.y + 1 })
          : t('edit.keyboard.size', { name, width: layout.w, height: layout.h }),
      );
    },
    [announce, byKey, t],
  );

  const start = (key: string, mode: KeyboardMode) => {
    setMoving({ key, mode, before: session.layout(), order: orderOf(widgets) });
    announce(t(mode === 'move' ? 'edit.keyboard.moveStart' : 'edit.keyboard.resizeStart'));
    focusLater(key);
  };

  const finish = (keep: boolean) => {
    if (moving === null) return;
    if (keep) {
      session.commitLayout(moving.before, session.layout());
      announce(t('edit.keyboard.done'));
    } else {
      session.preview(moving.before);
      announce(t('edit.keyboard.cancelled'));
    }
    setMoving(null);
    // The card goes to its new place in the DOM: give it the focus back.
    focusLater(moving.key);
  };

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (moving === null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      finish(true);
      return;
    }
    const direction = arrowDirection(event.key);
    if (direction === null) return;
    event.preventDefault();
    const items = widgets.map((widget) => ({ id: widget.key, ...widget.layout }));
    const next =
      moving.mode === 'move'
        ? moveItem(items, moving.key, direction)
        : resizeItem(items, moving.key, direction);
    if (next === null) {
      announce(
        t(moving.mode === 'move' ? 'edit.keyboard.cannotMove' : 'edit.keyboard.cannotResize'),
      );
      return;
    }
    const map = mapOf(next);
    session.preview(map);
    describe(moving.key, moving.mode, map[moving.key]);
  };

  const cards = order.flatMap((key) => {
    const widget = byKey.get(key);
    if (widget === undefined) return [];
    return [
      {
        widget,
        node: (
          <EditableWidget
            widget={widget}
            dashboardId={props.dashboardId}
            context={props.context}
            arrangeable={wide}
            canAdd={props.canAdd}
            keyboardMode={moving?.key === key ? moving.mode : null}
            sectionRef={(element) => {
              if (element === null) sections.current.delete(key);
              else sections.current.set(key, element);
            }}
            onConfigure={() => {
              props.onConfigure(key);
            }}
            onDuplicate={() => {
              props.onDuplicate(key);
            }}
            onRemove={() => {
              props.onRemove(key);
            }}
            onKeyboardStart={(mode) => {
              start(key, mode);
            }}
            onKeyboardKey={onKey}
            onKeyboardBlur={() => {
              finish(true);
            }}
          />
        ),
      },
    ];
  });

  if (!wide) {
    return (
      <ol
        className="flex flex-col"
        style={{ gap }}
        data-testid="dashboard-grid"
        data-layout="column"
      >
        {cards.map(({ widget, node }) => (
          <li
            key={widget.key}
            className="flex min-w-0 flex-col"
            style={{ height: singleColumnHeight(widget.layout.h, gap) }}
          >
            {node}
          </li>
        ))}
      </ol>
    );
  }
  return <WideEditableGrid session={session} gap={gap} widgets={widgets} cards={cards} />;
}

/** The id react-draggable looks for before injecting its selection style. */
const DRAGGABLE_STYLE_ID = 'react-draggable-style-el';

function WideEditableGrid({
  session,
  gap,
  widgets,
  cards,
}: {
  readonly session: DashboardEditorSession;
  readonly gap: number;
  readonly widgets: readonly EditorWidget[];
  readonly cards: readonly { readonly widget: EditorWidget; readonly node: React.ReactNode }[];
}) {
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1024 });
  const config = useMemo(() => gridConfig(gap), [gap]);
  const layout = useMemo<Layout>(
    () =>
      widgets.map((widget) => ({
        i: widget.key,
        ...widget.layout,
        minH: MIN_WIDGET_HEIGHT,
        maxH: MAX_WIDGET_HEIGHT,
      })),
    [widgets],
  );
  const commit = (next: Layout) => {
    session.commitLayout(session.layout(), mapOf(next));
  };
  return (
    <div ref={containerRef} data-testid="dashboard-grid" data-layout="grid" data-editing="true">
      {/* react-draggable injects an inline <style> unless this id exists (CSP: styles/index.css). */}
      <span id={DRAGGABLE_STYLE_ID} hidden />
      {mounted ? (
        <GridLayout
          className="relative [&_.react-grid-placeholder]:rounded-lg [&_.react-grid-placeholder]:border-2 [&_.react-grid-placeholder]:border-dashed [&_.react-grid-placeholder]:border-accent [&_.react-grid-placeholder]:bg-accent-soft"
          width={width}
          layout={layout}
          gridConfig={config}
          dragConfig={{ enabled: true, handle: `.${DRAG_HANDLE_CLASS}`, threshold: 3 }}
          resizeConfig={{
            enabled: true,
            handles: ['se'],
            handleComponent: (_axis, ref) => (
              <span
                ref={ref}
                aria-hidden="true"
                data-testid="widget-resize-handle"
                className="absolute right-0.5 bottom-0.5 size-4 cursor-se-resize rounded-br-lg border-r-2 border-b-2 border-line-strong hover:border-accent"
              />
            ),
          }}
          compactor={verticalCompactor}
          onDragStop={commit}
          onResizeStop={commit}
          autoSize
        >
          {cards.map(({ widget, node }) => (
            <div key={widget.key} className="flex min-w-0 flex-col">
              {node}
            </div>
          ))}
        </GridLayout>
      ) : null}
    </div>
  );
}
