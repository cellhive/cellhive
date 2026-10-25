import { Button, cn, FormField, Input, Select, Skeleton } from '@cellhive/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  Suspense,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import { translateDetail } from '../../../../lib/errors/translate';
import { fieldsQuery, tablesQuery } from '../../../../lib/query/queries';
import { showToast } from '../../../../lib/toast/toast';
import { TEST_IDS } from '../../test-ids';
import { WidgetCard } from '../../widgets/WidgetCard';
import { clientIssues, NO_ISSUES, serverIssues, type ConfigIssues } from '../config-issues';
import { widgetDtoOf } from '../EditableWidget';
import { defaultConfig } from '../widget-defaults';

import { arrayAt, setIn, stringAt, type ConfigPath } from './config-paths';
import {
  PanelContext,
  Section,
  TextSetting,
  useIssueText,
  type PanelContextValue,
} from './controls';
import {
  ChartDisplaySetting,
  ControlSetting,
  DimensionSetting,
  KpiSetting,
  MarkdownSetting,
  MetricsSetting,
  SeriesSetting,
  SortSetting,
  TableSetting,
  type ControlSiblings,
} from './sections';

import type { RecordFilterEditorProps } from '../../../../lib/schema/field-tools';
import type { WidgetDataContext } from '../../api';
import type { DashboardEditorSession, EditorWidget, WidgetContent } from '../editor-session';
import type { BaseDetail, FieldDto } from '@cellhive/contracts';

/** Settings are saved this long after the last change (the widget then shows the result). */
export const PANEL_SAVE_DELAY_MS = 800;

export interface WidgetPanelHandle {
  /** Drops edits not saved yet; `false` when there were none (undo then undoes a step). */
  discardDraft: () => boolean;
}

export interface WidgetPanelProps {
  readonly ref?: Ref<WidgetPanelHandle>;
  readonly widget: EditorWidget;
  readonly widgets: readonly EditorWidget[];
  readonly session: DashboardEditorSession;
  readonly base: BaseDetail;
  readonly dashboardId: string;
  readonly context: WidgetDataContext;
  readonly FilterEditor?: ComponentType<RecordFilterEditorProps> | undefined;
  /** Below 768 px: the whole screen. */
  readonly fullScreen: boolean;
  readonly onClose: () => void;
}

const NO_FIELDS: readonly FieldDto[] = [];
const DESCRIPTION_PATH = ['description'];
const FILTER_PATH = ['filter'];
const METRICS_PATH = ['metrics'];
const DIMENSION_PATH = ['dimension'];
const DATA_TYPES = new Set(['kpi', 'bar', 'line', 'pie', 'combo', 'table']);

function nameOf(widget: Pick<EditorWidget, 'title'>, typeName: string): string {
  return widget.title.trim() === '' ? typeName : widget.title;
}

/**
 * The settings of one widget (T812, research §5.1; a panel at the right,
 * the whole screen below 768 px): title, source table, filter (the view's
 * filter builder — one DSL), grouping, metrics with the aggregations their
 * fields allow (fields that do not fit are not offered), sort/limit/"Other",
 * display, KPI comparison and targets, table mode, Markdown, filter control.
 *
 * Changes are saved 0.8 s after the last one (`PATCH /widgets/:id`) and the
 * widget on the grid shows the result: the data endpoint only computes
 * saved configs (CONTRACTS §28.3), so the preview is "save, then load". A
 * `422` shows at the setting it names, nothing is lost.
 */
export function WidgetPanel({
  ref,
  widget,
  widgets,
  session,
  base,
  dashboardId,
  context,
  FilterEditor,
  fullScreen,
  onClose,
}: WidgetPanelProps) {
  const { t, i18n } = useTranslation('dashboard');
  const queryClient = useQueryClient();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const saved = useMemo<WidgetContent>(
    () => ({ title: widget.title, config: widget.config }),
    [widget.title, widget.config],
  );
  const savedJson = JSON.stringify(saved);
  const [draft, setDraft] = useState<WidgetContent>(saved);
  const [synced, setSynced] = useState(savedJson);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<ConfigIssues>(NO_ISSUES);
  /** Remounts the filter builder when the filter changes from outside (undo). */
  const [revision, setRevision] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The draft as of the last edit (handlers run between renders). */
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  });

  // Saved settings changed from outside (undo/redo, a reload): show them unless editing.
  if (savedJson !== synced) {
    setSynced(savedJson);
    if (!dirty) {
      setDraft(saved);
      setIssues(NO_ISSUES);
      setRevision((value) => value + 1);
    }
  }

  const save = async (content: WidgetContent) => {
    timer.current = null;
    const local = clientIssues(widget.type, content);
    if (local.size > 0) {
      setIssues(local);
      return;
    }
    const result = await session.saveContent(widget.key, content);
    if (latest.current !== content) return; // edited again meanwhile: the next save decides
    if (result.ok) {
      setDirty(false);
      setIssues(NO_ISSUES);
    } else if (result.error !== null) {
      setIssues(serverIssues(result.error));
    }
  };

  const edit = (next: WidgetContent) => {
    latest.current = next;
    setDraft(next);
    setDirty(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void save(next);
    }, PANEL_SAVE_DELAY_MS);
  };

  useImperativeHandle(
    ref,
    () => ({
      discardDraft: () => {
        if (!dirty) return false;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        latest.current = saved;
        setDraft(saved);
        setDirty(false);
        setIssues(NO_ISSUES);
        setRevision((value) => value + 1);
        return true;
      },
    }),
    [dirty, saved],
  );

  // Closing the panel saves what waits (a valid draft).
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      const content = latest.current;
      if (clientIssues(widget.type, content).size === 0) {
        void session.saveContent(widget.key, content);
      }
    },
    [session, widget.key, widget.type],
  );

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const tableId = stringAt(draft.config, ['table_id']);
  const fields = useQuery({ ...fieldsQuery(tableId ?? ''), enabled: tableId !== null });
  const tables = useQuery(tablesQuery(base.id));
  const fieldList = fields.data?.items ?? NO_FIELDS;

  const panel: PanelContextValue = {
    config: draft.config,
    issues,
    update: (path: ConfigPath, value: unknown) => {
      edit({ ...latest.current, config: setIn(latest.current.config, path, value) });
    },
  };

  const changeTable = async (nextTable: string) => {
    try {
      const nextFields = await queryClient.query(fieldsQuery(nextTable));
      const config = defaultConfig(widget.type, nextTable, nextFields.items);
      if (config === null) {
        setIssues(new Map([['table_id', [{ code: 'NO_FITTING_FIELD' }]]]));
        return;
      }
      const description = latest.current.config['description'];
      edit({
        ...latest.current,
        config: description === undefined ? config : { ...config, description },
      });
    } catch (error) {
      showToast({ variant: 'error', error });
    }
  };

  const typeName = t(`type.${widget.type}`);
  const general = issues.get('');
  const data = DATA_TYPES.has(widget.type);

  const controlSiblings: ControlSiblings = {
    saved: widget.id !== null,
    selfId: widget.id,
    controls: widgets
      .filter((item) => item.type === 'filter_control' && item.id !== null)
      .map((item) => ({
        id: item.id as string,
        name: nameOf(item, t('type.filter_control')),
        tableId: stringAt(item.config, ['table_id']) ?? '',
        parent: stringAt(item.config, ['parent_control_id']),
      })),
    targets: widgets
      .filter(
        (item) =>
          DATA_TYPES.has(item.type) &&
          item.id !== null &&
          stringAt(item.config, ['table_id']) === tableId,
      )
      .map((item) => ({
        key: item.key,
        name: nameOf(item, t(`type.${item.type}`)),
        bound:
          widget.id !== null &&
          arrayAt<string>(item.config, ['filter_bindings']).includes(widget.id),
      })),
    onBind: (key, bound) => {
      const target = widgets.find((item) => item.key === key);
      if (target === undefined || widget.id === null) return;
      const current = arrayAt<string>(target.config, ['filter_bindings']);
      const next = bound
        ? [...current.filter((id) => id !== widget.id), widget.id]
        : current.filter((id) => id !== widget.id);
      void session
        .saveContent(key, {
          title: target.title,
          config: { ...target.config, filter_bindings: next },
        })
        .then((result) => {
          if (!result.ok && result.error !== null)
            showToast({ variant: 'error', error: result.error });
        });
    },
  };

  return (
    <aside
      aria-labelledby={headingId}
      data-testid="widget-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
      className={cn(
        'flex flex-col bg-surface',
        fullScreen
          ? 'fixed inset-0 z-40 overflow-y-auto'
          : 'sticky top-0 h-dvh w-[400px] shrink-0 overflow-y-auto border-l border-line',
      )}
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-line bg-surface px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <h2
            id={headingId}
            ref={heading}
            tabIndex={-1}
            className="truncate text-heading font-semibold text-fg outline-none"
          >
            {t('edit.panel.title', { name: nameOf(draft, typeName) })}
          </h2>
          <p
            className="text-label font-normal text-fg-muted"
            role="status"
            data-testid="widget-panel-state"
          >
            {!dirty
              ? t('edit.panel.saved')
              : issues.size > 0
                ? t('edit.panel.invalid')
                : t('edit.panel.saving')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('edit.panel.close')}
          onClick={onClose}
          data-testid="widget-panel-close"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <PanelContext.Provider value={panel}>
        <div className="flex flex-col gap-4 px-4 pt-3 pb-8">
          {fullScreen && widget.id !== null ? (
            <div className="h-64" data-testid="widget-panel-preview">
              <WidgetCard widget={widgetDtoOf(widget, dashboardId)} context={context} admin />
            </div>
          ) : null}
          {general === undefined ? null : (
            <p role="alert" className="rounded-md border border-danger p-3 text-body text-danger">
              {general.map((detail) => translateDetail(i18n, detail)).join(' ')}
            </p>
          )}
          <TitleField
            value={draft.title}
            placeholder={typeName}
            onChange={(title) => {
              edit({ ...latest.current, title });
            }}
          />
          {data || widget.type === 'filter_control' ? (
            <SourceField
              tables={tables.data?.items ?? []}
              value={tableId}
              onChange={(next) => {
                void changeTable(next);
              }}
            />
          ) : null}
          {data ? (
            <TextSetting
              path={DESCRIPTION_PATH}
              label={t('edit.panel.description')}
              maxLength={500}
            />
          ) : null}
          {tableId !== null && fields.isPending ? (
            <Skeleton className="h-40" aria-hidden="true" />
          ) : null}
          {data && !fields.isPending ? (
            <>
              <Section title={t('edit.panel.filter')}>
                <FilterField
                  key={`${tableId ?? ''}:${String(revision)}`}
                  FilterEditor={FilterEditor}
                  tableId={tableId}
                  orgId={base.organization_id}
                  value={
                    (draft.config['filter'] as Readonly<Record<string, unknown>> | null) ?? null
                  }
                  onChange={(filter) => {
                    panel.update(FILTER_PATH, filter);
                  }}
                />
              </Section>
              <TypeSettings type={widget.type} fields={fieldList} config={draft.config} />
            </>
          ) : null}
          {widget.type === 'text' ? <MarkdownSetting /> : null}
          {widget.type === 'filter_control' && !fields.isPending ? (
            <Section title={t('edit.panel.control')}>
              <ControlSetting fields={fieldList} siblings={controlSiblings} />
            </Section>
          ) : null}
        </div>
      </PanelContext.Provider>
    </aside>
  );
}

function TitleField({
  value,
  placeholder,
  onChange,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation('dashboard');
  const error = useIssueText('title');
  return (
    <FormField label={t('edit.panel.widgetTitle')} error={error}>
      {(control) => (
        <Input
          {...control}
          value={value}
          placeholder={placeholder}
          maxLength={200}
          data-testid="widget-title-input"
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      )}
    </FormField>
  );
}

function SourceField({
  tables,
  value,
  onChange,
}: {
  readonly tables: readonly { readonly id: string; readonly name: string }[];
  readonly value: string | null;
  readonly onChange: (tableId: string) => void;
}) {
  const { t } = useTranslation('dashboard');
  const error = useIssueText('table_id');
  return (
    <FormField label={t('edit.panel.table')} error={error}>
      {(control) => (
        <Select
          {...control}
          value={value ?? ''}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        >
          {value !== null && !tables.some((table) => table.id === value) ? (
            <option value={value}>{t('edit.panel.tableGone')}</option>
          ) : null}
          {tables.map((table) => (
            <option key={table.id} value={table.id}>
              {table.name}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  );
}

function FilterField({
  FilterEditor,
  tableId,
  orgId,
  value,
  onChange,
}: {
  readonly FilterEditor: ComponentType<RecordFilterEditorProps> | undefined;
  readonly tableId: string | null;
  readonly orgId: string;
  readonly value: Readonly<Record<string, unknown>> | null;
  readonly onChange: (value: Readonly<Record<string, unknown>> | null) => void;
}) {
  const { t } = useTranslation('dashboard');
  const error = useIssueText('filter', true);
  if (FilterEditor === undefined || tableId === null) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-label font-normal text-fg-muted">{t('edit.panel.filterHint')}</p>
      <Suspense fallback={<Skeleton className="h-16" aria-hidden="true" />}>
        <FilterEditor
          tableId={tableId}
          orgId={orgId}
          value={value}
          onChange={onChange}
          emptyText={t('edit.panel.filterEmpty')}
        />
      </Suspense>
      {error === undefined ? null : <p className="text-label font-normal text-danger">{error}</p>}
    </div>
  );
}

function TypeSettings({
  type,
  fields,
  config,
}: {
  readonly type: EditorWidget['type'];
  readonly fields: readonly FieldDto[];
  readonly config: Readonly<Record<string, unknown>>;
}) {
  const { t } = useTranslation('dashboard');
  const series = config['series_dimension'] !== null && config['series_dimension'] !== undefined;
  switch (type) {
    case 'kpi':
      return (
        <>
          <Section title={t('edit.panel.metric')}>
            <MetricsSetting path={METRICS_PATH} fields={fields} min={1} max={1} />
          </Section>
          <Section title={t('edit.panel.kpi')}>
            <KpiSetting fields={fields} />
          </Section>
        </>
      );
    case 'bar':
    case 'line':
    case 'pie':
    case 'combo':
      return (
        <>
          <Section title={t('edit.panel.grouping')}>
            <DimensionSetting
              path={DIMENSION_PATH}
              label={t('edit.panel.dimension')}
              fields={fields}
              testId={TEST_IDS.dimensionField}
            />
            {type === 'bar' || type === 'line' ? <SeriesSetting fields={fields} /> : null}
          </Section>
          <Section title={t('edit.panel.metrics')}>
            <MetricsSetting
              path={METRICS_PATH}
              fields={fields}
              min={type === 'combo' ? 2 : 1}
              max={type === 'pie' || series ? 1 : 5}
              combo={type === 'combo'}
            />
          </Section>
          <Section title={t('edit.panel.sorting')}>
            <SortSetting others={type === 'pie'} />
          </Section>
          <Section title={t('edit.panel.display')}>
            <ChartDisplaySetting type={type} />
          </Section>
        </>
      );
    case 'table':
      return (
        <Section title={t('edit.panel.tableSection')}>
          <TableSetting fields={fields} />
        </Section>
      );
    default:
      return null;
  }
}
