import { MAX_WIDGETS_PER_DASHBOARD } from '@cellhive/contracts';
import { Button, cn } from '@cellhive/ui';
import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  LayoutDashboard,
  Palette,
  Plus,
  Redo2,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { PAGE_GUTTER, PageHeading } from '../../../lib/layout/page-heading';
import { dashboardQuery, loadDashboardsApi } from '../../../lib/query/dashboards';
import { showToast } from '../../../lib/toast/toast';
import { DENSITY_GAP, densityOf } from '../model/theme';
import { TEST_IDS } from '../test-ids';
import { DashboardSurface } from '../view/DashboardSurface';

import { EditableGrid } from './EditableGrid';
import { DashboardEditorSession, type EditorApi } from './editor-session';
import { GlobalFiltersDialog } from './GlobalFiltersDialog';
import { WidgetPanel, type WidgetPanelHandle } from './panel/WidgetPanel';
import { ThemeDialog } from './ThemeDialog';
import { useMediaQuery } from './use-media-query';
import { WidgetLibrary } from './WidgetLibrary';

import type { RecordFilterEditorProps } from '../../../lib/schema/field-tools';
import type { WidgetDataContext } from '../api';
import type { BaseDetail, DashboardDto } from '@cellhive/contracts';

/** The dashboard API for the session, loaded with the editor. */
const editorApi: EditorApi = {
  putLayout: async (...args) => (await loadDashboardsApi()).putLayout(...args),
  createWidget: async (...args) => (await loadDashboardsApi()).createWidget(...args),
  updateWidget: async (...args) => (await loadDashboardsApi()).updateWidget(...args),
  removeWidget: async (...args) => (await loadDashboardsApi()).removeWidget(...args),
  updateTheme: async (...args) => (await loadDashboardsApi()).updateTheme(...args),
  updateGlobalFilters: async (...args) => (await loadDashboardsApi()).updateGlobalFilters(...args),
};

/** Below 768 px the settings panel takes the whole screen (BACKLOG T812). */
const PANEL_SIDE_QUERY = '(min-width: 768px)';
const UNDO_KEYS = 'Control+Z Meta+Z';
const REDO_KEYS = 'Control+Shift+Z Meta+Shift+Z Control+Y';
/** Callbacks until the page sets its own (nothing can fail before). */
const QUIET = { onConflict: () => undefined, onError: () => undefined };

function isTyping(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export interface DashboardEditorProps {
  readonly dashboard: DashboardDto;
  readonly base: BaseDetail;
  readonly context: WidgetDataContext;
  readonly FilterEditor?: ComponentType<RecordFilterEditorProps> | undefined;
  readonly onDone: () => void;
}

/**
 * `?edit=1` of a dashboard (T812, SPEC §10.1, research §5.1), base owners
 * and admins only: the edit bar (Add widget, Theme, Undo/Redo, Done), the
 * grid where widgets are dragged, resized or moved with the keyboard, the
 * settings panel of one widget (right, full screen below 768 px). Every
 * change is saved as it is made — the layout 1 s after the last move — and
 * a change made elsewhere meanwhile (`409`) reloads the dashboard with a
 * message. Undo/redo lasts as long as the page (50 steps).
 */
export default function DashboardEditor({
  dashboard,
  base,
  context,
  FilterEditor,
  onDone,
}: DashboardEditorProps) {
  const { t } = useTranslation('dashboard');
  const queryClient = useQueryClient();
  const [session] = useState(
    () => new DashboardEditorSession(dashboard.id, dashboard, editorApi, QUIET),
  );
  useEffect(() => {
    session.setEvents({
      onConflict: () => {
        void queryClient
          .query({ ...dashboardQuery(dashboard.id), staleTime: 0 })
          .then((fresh) => {
            session.reset(fresh);
            showToast({
              variant: 'warning',
              title: t('edit.conflict.title'),
              message: t('edit.conflict.message'),
            });
          })
          .catch((error: unknown) => {
            showToast({ variant: 'error', error });
          });
      },
      onError: (error) => {
        showToast({ variant: 'error', error });
      },
    });
  }, [session, queryClient, dashboard.id, t]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [announcement, setAnnouncement] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const panel = useRef<WidgetPanelHandle>(null);
  const panelBeside = useMediaQuery(PANEL_SIDE_QUERY, true);
  const selectedWidget = state.widgets.find((widget) => widget.key === selected);
  const canAdd = state.widgets.length < MAX_WIDGETS_PER_DASHBOARD;

  // What waits is saved when the page is left (the session lives as long as the page).
  useEffect(
    () => () => {
      session.dispose();
    },
    [session],
  );

  // A change saved elsewhere (another admin) while nothing waits here: take it.
  useEffect(() => {
    if (dashboard.version > session.currentVersion && session.idle) {
      session.reset(dashboard);
      showToast({ variant: 'info', message: t('edit.reloaded') });
    }
  }, [dashboard, session, t]);

  const announce = useCallback((text: string) => {
    // The same text twice is still announced (a fresh node each time).
    setAnnouncement('');
    window.requestAnimationFrame(() => {
      setAnnouncement(text);
    });
  }, []);

  const undo = () => {
    if (panel.current?.discardDraft() === true) {
      announce(t('edit.undone'));
      return;
    }
    if (!state.canUndo) return;
    session.undo();
    announce(t('edit.undone'));
  };
  const redo = () => {
    if (!state.canRedo) return;
    session.redo();
    announce(t('edit.redone'));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || isTyping(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      redo();
    }
  };

  const done = () => {
    void session.flush().then(onDone);
  };

  const panelOpen = selectedWidget !== undefined;
  const closePanel = useCallback(() => {
    const key = selected;
    setSelected(null);
    if (key !== null) {
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `[data-testid="widget-${CSS.escape(state.widgets.find((w) => w.key === key)?.id ?? key)}"]`,
          )
          ?.focus();
      });
    }
  }, [selected, state.widgets]);

  return (
    <DashboardSurface theme={state.theme} testId={TEST_IDS.dashboardPage} className="relative">
      <div onKeyDown={onKeyDown} inert={panelOpen && !panelBeside} className="flex flex-1 flex-col">
        <PageHeading
          icon={LayoutDashboard}
          title={<span data-testid="dashboard-title">{dashboard.name}</span>}
          subtitle={t('edit.subtitle')}
        />
        <div
          role="toolbar"
          aria-label={t('edit.toolbar')}
          data-testid="dashboard-edit-bar"
          className={cn(
            PAGE_GUTTER,
            'sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-line bg-surface py-2',
          )}
        >
          <Button
            variant="primary"
            disabled={!canAdd}
            onClick={() => {
              setLibraryOpen(true);
            }}
            data-testid="dashboard-add-widget"
          >
            <Plus aria-hidden="true" />
            {t('edit.add')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setThemeOpen(true);
            }}
          >
            <Palette aria-hidden="true" />
            {t('edit.theme.open')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setFiltersOpen(true);
            }}
            data-testid="dashboard-global-filters"
          >
            <SlidersHorizontal aria-hidden="true" />
            {t('edit.globalFilters.open')}
          </Button>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('edit.undo')}
              aria-keyshortcuts={UNDO_KEYS}
              disabled={!state.canUndo}
              onClick={undo}
              data-testid="dashboard-undo"
            >
              <Undo2 aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('edit.redo')}
              aria-keyshortcuts={REDO_KEYS}
              disabled={!state.canRedo}
              onClick={redo}
              data-testid="dashboard-redo"
            >
              <Redo2 aria-hidden="true" />
            </Button>
          </div>
          <p
            className="text-label font-normal text-fg-muted"
            role="status"
            data-testid="dashboard-save-state"
          >
            {state.saving ? t('edit.saving') : t('edit.saved')}
          </p>
          {canAdd ? null : (
            <p className="text-label font-normal text-fg-muted">
              {t('edit.limit', { max: MAX_WIDGETS_PER_DASHBOARD })}
            </p>
          )}
          <Button
            className="ml-auto"
            variant="secondary"
            onClick={done}
            data-testid="dashboard-edit-done"
          >
            <Check aria-hidden="true" />
            {t('edit.done')}
          </Button>
        </div>
        <div className="flex flex-1 items-start">
          <div className={cn(PAGE_GUTTER, 'min-w-0 flex-1 py-6')}>
            {state.widgets.length === 0 ? (
              <div
                className="mx-auto flex max-w-lg flex-col items-center gap-3 rounded-lg border border-dashed border-line-strong p-8 text-center"
                data-testid="dashboard-empty"
              >
                <p className="text-heading font-semibold text-fg">{t('edit.empty.title')}</p>
                <p className="text-body text-fg-muted">{t('edit.empty.detail')}</p>
                <Button
                  onClick={() => {
                    setLibraryOpen(true);
                  }}
                >
                  <Plus aria-hidden="true" />
                  {t('edit.add')}
                </Button>
              </div>
            ) : (
              <EditableGrid
                widgets={state.widgets}
                session={session}
                dashboardId={dashboard.id}
                context={context}
                gap={DENSITY_GAP[densityOf(state.theme)]}
                canAdd={canAdd}
                announce={announce}
                onConfigure={setSelected}
                onDuplicate={(key) => {
                  const copy = session.duplicate(key);
                  if (copy !== null) announce(t('edit.widget.duplicated'));
                }}
                onRemove={(key) => {
                  if (selected === key) setSelected(null);
                  session.remove(key);
                  announce(t('edit.widget.deleted'));
                }}
              />
            )}
          </div>
          {panelOpen && panelBeside ? (
            <WidgetPanel
              ref={panel}
              key={selectedWidget.key}
              widget={selectedWidget}
              widgets={state.widgets}
              session={session}
              base={base}
              dashboardId={dashboard.id}
              context={context}
              FilterEditor={FilterEditor}
              fullScreen={false}
              onClose={closePanel}
            />
          ) : null}
        </div>
      </div>
      {panelOpen && !panelBeside ? (
        <WidgetPanel
          ref={panel}
          key={selectedWidget.key}
          widget={selectedWidget}
          widgets={state.widgets}
          session={session}
          base={base}
          dashboardId={dashboard.id}
          context={context}
          FilterEditor={FilterEditor}
          fullScreen
          onClose={closePanel}
        />
      ) : null}
      <div aria-live="polite" className="sr-only" data-testid="dashboard-announcer">
        {announcement}
      </div>
      <WidgetLibrary
        open={libraryOpen}
        baseId={base.id}
        onClose={() => {
          setLibraryOpen(false);
        }}
        onAdd={(type, content, size) => {
          const key = session.addWidget(type, content, size);
          setLibraryOpen(false);
          if (key === null) return;
          setSelected(key);
          announce(t('edit.widget.added', { type: t(`type.${type}`) }));
        }}
      />
      <ThemeDialog
        open={themeOpen}
        theme={state.theme}
        onChange={(theme) => {
          session.setTheme(theme);
        }}
        onClose={() => {
          setThemeOpen(false);
        }}
      />
      <GlobalFiltersDialog
        key={filtersOpen ? 'open' : 'closed'}
        open={filtersOpen}
        baseId={base.id}
        filters={state.globalFilters}
        onSave={(filters) => {
          session.setGlobalFilters(filters);
        }}
        onClose={() => {
          setFiltersOpen(false);
        }}
      />
    </DashboardSurface>
  );
}
