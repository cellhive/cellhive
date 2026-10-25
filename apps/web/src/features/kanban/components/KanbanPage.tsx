import { Select } from '@cellhive/ui';
import { useQueryClient, useSuspenseQuery, type QueryClient } from '@tanstack/react-query';
import { SquareKanban } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useEffect,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import { orderGridFields, type GridField } from '../../../grid/types';
import { tableUndo } from '../../../grid/undo/table-undo';
import { useFormatters } from '../../../lib/i18n/format';
import { canDownloadFile, canSaveViewConfig } from '../../../lib/permissions/access';
import { baseQuery, fieldsQuery, tableQuery } from '../../../lib/query/queries';
import { RECORD_PARAM, type RecordDetailComponents } from '../../../lib/records/detail';
import { cachedRecord } from '../../../lib/records/record-sync';
import { showToast } from '../../../lib/toast/toast';
import { useViewConfig } from '../../../lib/views/use-view-config';
import { defaultCardFields, groupKindOf, kanbanSettingsOf } from '../board';

import { KanbanBoard } from './KanbanBoard';
import { BoardSettings, KanbanToolbar } from './KanbanToolbar';

import type { BoardQuery } from '../queries';
import type { StoredKanbanSettings, ViewDto } from '@cellhive/contracts';

const NARROW_QUERY = '(max-width: 767.98px)';

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

export interface KanbanPageProps {
  /** The kanban view on screen (T310): its config holds the board settings. */
  readonly view: ViewDto;
  /**
   * Record panel and history (T206), lazy components given by the route:
   * features do not import each other (FRONTEND §1.2).
   */
  readonly RecordDetail?: RecordDetailComponents | undefined;
}

/** The record for the panel to show at once: its newest cached copy. */
function initialRecordOf(queryClient: QueryClient, tableId: string, recordId: string) {
  return cachedRecord(queryClient, tableId, recordId);
}

/**
 * A kanban view (`/b/:baseId/t/:tableId/v/:viewId`, SPEC §8, T314): the
 * records as cards in one column per value of the group field (a single
 * select or single user), with an "Uncategorized" column. The route guard
 * has loaded the base, table, fields and views.
 */
export function KanbanPage({ view, RecordDetail }: KanbanPageProps) {
  const { t } = useTranslation('kanban');
  const { baseId = '', tableId = '' } = useParams();
  const queryClient = useQueryClient();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const { data: table } = useSuspenseQuery(tableQuery(tableId));
  const { data: fieldList } = useSuspenseQuery(fieldsQuery(tableId));
  const state = useViewConfig(view, canSaveViewConfig(base.access, tableId, view));
  const settings = kanbanSettingsOf(state.config.kanban);

  const fields = useMemo(() => orderGridFields(fieldList.items), [fieldList]);
  const primary = fields.find((field) => field.field.is_primary) ?? fields[0];
  const groupFields = useMemo(
    () => fields.filter((field) => groupKindOf(field.field) !== null),
    [fields],
  );
  const groupField = groupFields.find((field) => field.field.id === settings.group_field);
  const kind = groupField === undefined ? null : groupKindOf(groupField.field);
  const cardCandidates = useMemo(() => fields.filter((field) => !field.field.is_primary), [fields]);
  const cardFields = useMemo(() => {
    const byId = new Map<string, GridField>(cardCandidates.map((field) => [field.field.id, field]));
    return settings.card_fields.flatMap((fieldId) => {
      const field = byId.get(fieldId);
      return field === undefined ? [] : [field];
    });
  }, [cardCandidates, settings.card_fields]);

  // Cover image (T418, `cover_field`): an attachment field the user reads.
  const coverFields = useMemo(
    () => fields.filter((field) => field.config?.type === 'attachment'),
    [fields],
  );
  const coverField = coverFields.find((field) => field.field.id === settings.cover_field);
  const cover = useMemo(
    () =>
      coverField === undefined
        ? null
        : {
            field: coverField,
            canView: canDownloadFile(base.access, tableId, coverField.field.id),
          },
    [coverField, base.access, tableId],
  );

  const { change } = state;
  const update = useCallback(
    (patch: Partial<StoredKanbanSettings>) => {
      change({ kanban: { ...settings, ...patch } });
    },
    [change, settings],
  );
  // A board grouped for the first time shows a few fields on its cards (not bare titles).
  const pickGroupField = useCallback(
    (fieldId: string) => {
      const first = settings.group_field === null && settings.card_fields.length === 0;
      update(
        first
          ? { group_field: fieldId, card_fields: defaultCardFields(cardCandidates, fieldId) }
          : { group_field: fieldId },
      );
    },
    [settings.group_field, settings.card_fields.length, update, cardCandidates],
  );

  const format = useFormatters();
  const locale = useMemo(
    () => ({ locale: format.locale, timeZone: format.timeZone }),
    [format.locale, format.timeZone],
  );
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);

  // Record panel (FRONTEND §10.1): `?record=rec_…`, as on the grid.
  const [searchParams, setSearchParams] = useSearchParams();
  const openRecordId = RecordDetail === undefined ? null : searchParams.get(RECORD_PARAM);
  const setOpenRecord = useCallback(
    (recordId: string | null, replace: boolean) => {
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          if (recordId === null) next.delete(RECORD_PARAM);
          else next.set(RECORD_PARAM, recordId);
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );
  const openRef = useRef(openRecordId);
  useEffect(() => {
    openRef.current = openRecordId;
  });
  const openRecord = useCallback(
    (recordId: string) => {
      if (RecordDetail !== undefined) setOpenRecord(recordId, openRef.current !== null);
    },
    [RecordDetail, setOpenRecord],
  );
  const onRecordsGone = useCallback(
    (recordIds: readonly string[]) => {
      const open = openRef.current;
      if (open === null || !recordIds.includes(open)) return;
      showToast({ message: t('grid:realtime.recordGone') });
      setOpenRecord(null, true);
    },
    [setOpenRecord, t],
  );
  const [order, setOrder] = useState<readonly string[]>([]);
  const position = openRecordId === null ? -1 : order.indexOf(openRecordId);
  const neighbors = {
    previous: position > 0 ? (order[position - 1] ?? null) : null,
    next: position >= 0 ? (order[position + 1] ?? null) : null,
  };

  const query = useMemo<BoardQuery | null>(
    () =>
      groupField === undefined || kind === null
        ? null
        : {
            tableId,
            viewId: view.id,
            permissionVersion: base.permission_version,
            groupFieldId: groupField.field.id,
            kind,
            sort: state.config.sort,
          },
    [groupField, kind, tableId, view.id, base.permission_version, state.config.sort],
  );

  const boardSettings = (
    <BoardSettings
      groupFields={groupFields}
      groupFieldId={groupField?.field.id ?? null}
      fields={cardCandidates}
      cardFields={settings.card_fields}
      hideEmpty={settings.hide_empty_columns}
      onGroupField={pickGroupField}
      onCardFields={(fieldIds) => {
        update({ card_fields: fieldIds });
      }}
      onHideEmpty={(hide) => {
        update({ hide_empty_columns: hide });
      }}
      coverFields={coverFields}
      coverFieldId={coverField?.field.id ?? null}
      onCoverField={(fieldId) => {
        update({ cover_field: fieldId });
      }}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {query === null || groupField === undefined || kind === null ? (
        <>
          <KanbanToolbar>{boardSettings}</KanbanToolbar>
          <KanbanSetup groupFields={groupFields} onPick={pickGroupField} />
        </>
      ) : (
        <KanbanBoard
          // A new board (columns, loaded pages) per group field.
          key={groupField.field.id}
          base={base}
          query={query}
          groupField={groupField}
          kind={kind}
          fields={fields}
          primary={primary}
          cardFields={cardFields}
          cover={cover}
          hideEmpty={settings.hide_empty_columns}
          onHideEmpty={(hide) => {
            update({ hide_empty_columns: hide });
          }}
          locale={locale}
          narrow={narrow}
          label={t('board.label', { table: table.name, field: groupField.field.name })}
          onOpen={openRecord}
          onRecordsGone={onRecordsGone}
          onCardsChange={setOrder}
          settings={boardSettings}
        />
      )}
      {RecordDetail === undefined || openRecordId === null ? null : (
        <Suspense fallback={null}>
          <RecordDetail.Panel
            base={base}
            tableId={tableId}
            tableName={table.name}
            recordId={openRecordId}
            fields={fieldList.items}
            hiddenFieldIds={state.config.hidden_fields}
            initialRecord={initialRecordOf(queryClient, tableId, openRecordId)}
            neighbors={neighbors}
            onNavigate={(recordId) => {
              setOpenRecord(recordId, true);
            }}
            onClose={() => {
              setOpenRecord(null, true);
            }}
            fullScreen={narrow}
            onCommand={tableUndo(tableId).hooks.push}
            History={RecordDetail.History}
            CellHistory={RecordDetail.CellHistory}
            Attachments={RecordDetail.Attachments}
            view={view}
          />
        </Suspense>
      )}
    </div>
  );
}

/** A kanban view without a group field yet: pick one (or learn which field type is needed). */
function KanbanSetup({
  groupFields,
  onPick,
}: {
  groupFields: readonly GridField[];
  onPick: (fieldId: string) => void;
}) {
  const { t } = useTranslation('kanban');
  const id = useId();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-canvas p-8 text-center">
      <SquareKanban aria-hidden="true" className="size-8 text-fg-muted" />
      <h2 className="text-heading">{t('setup.title')}</h2>
      {groupFields.length === 0 ? (
        <p className="max-w-md text-fg-muted">{t('setup.noField')}</p>
      ) : (
        <>
          <p className="max-w-md text-fg-muted">{t('setup.description')}</p>
          <label htmlFor={id} className="sr-only">
            {t('setup.label')}
          </label>
          <Select
            id={id}
            className="max-w-64"
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onPick(event.target.value);
            }}
          >
            <option value="">{t('setup.placeholder')}</option>
            {groupFields.map(({ field }) => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </Select>
        </>
      )}
    </div>
  );
}

export default KanbanPage;
