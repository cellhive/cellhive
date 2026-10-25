import type { ReadOnlyFilesProps, ReadOnlyViewerProps } from '../attachments/ui';
import type { FormRendererComponent } from '../forms/renderer';
import type { EffectiveRecordQuery } from '../query/keys';
import type { ViewToolbarComponents } from '../views/toolbar';
import type {
  RecordDto,
  RecordListResponse,
  SharedDashboardDto,
  WidgetDataDto,
  WidgetDataRequest,
  WidgetLiveFilterInput,
  WidgetOptionsDto,
  WidgetOptionsRequest,
} from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * What the public share page (`/s/:token`, `features/share/public`, T317)
 * gets from the route: parts owned by other features (FRONTEND §1.2), each
 * a chunk of its own loaded with the share route.
 */

/** Rows the grid shows (FRONTEND §3.3): the windowed block loader of the grid. */
export interface WindowedRowsSnapshot {
  /** `loading` until the row count is known, `error` when it could not be. */
  readonly status: 'loading' | 'ready' | 'error';
  readonly rowCount: number;
  /** `rowCount` is an estimate (more than 100 000 rows). */
  readonly estimated: boolean;
  /** Last failure of a block fetch, until a retry succeeds. */
  readonly error: unknown;
  /** Increases whenever rows or counts change (the grid redraws). */
  readonly version: number;
}

export interface WindowedRows {
  /** The record of a row, `undefined` while its block loads. */
  readonly getRecord: (row: number) => RecordDto | undefined;
  /** The rows on screen changed. */
  readonly setViewport: (range: { firstRow: number; lastRow: number }, dragging?: boolean) => void;
  /** The records of a range, loading missing blocks (copy of a large selection). */
  readonly loadRows: (firstRow: number, lastRow: number) => Promise<(RecordDto | undefined)[]>;
  /** Reloads the loaded blocks and the row count (refresh button, polling). */
  readonly refresh: () => void;
  /** Tries the failed blocks again. */
  readonly retry: () => void;
}

/** One block of 200 rows (`offset = index * 200`) through the share API. */
export type FetchRecordBlock = (index: number, signal: AbortSignal) => Promise<RecordListResponse>;

/**
 * The block loader for `query` (its hash keys the blocks) whose blocks come
 * from `fetchBlock`. `scope` names the cache entries (one per link).
 */
export type UseWindowedRows = (
  scope: string,
  query: EffectiveRecordQuery,
  fetchBlock: FetchRecordBlock,
) => { readonly rows: WindowedRows; readonly snapshot: WindowedRowsSnapshot };

/**
 * (T814) What the widgets of a dashboard link read (CONTRACTS §16A):
 * `/shares/:token/widgets/:id/data|options|export`, with the unlock CSRF
 * header of the link. Built by `features/share/public`, used by the
 * dashboard renderer of `features/dashboard/share`.
 */
export interface SharedDashboardSource {
  /** Prefix of the cache entries of the widgets of this link (never a member key). */
  readonly widgetsKey: readonly unknown[];
  /** Cache entry of `GET /shares/:token/dashboard` (read again when a widget is gone). */
  readonly dashboardKey: readonly unknown[];
  readonly widgetData: (
    widgetId: string,
    body: WidgetDataRequest,
    signal?: AbortSignal,
  ) => Promise<WidgetDataDto>;
  readonly widgetOptions: (
    widgetId: string,
    body: WidgetOptionsRequest,
    signal?: AbortSignal,
  ) => Promise<WidgetOptionsDto>;
  /** `GET /shares/:token/widgets/:id/export?format=csv…` (with `allow_export`). */
  readonly widgetCsvUrl: (
    widgetId: string,
    filters: readonly WidgetLiveFilterInput[],
    timezone: string | null,
  ) => string;
}

export interface SharedDashboardProps {
  /** `GET /shares/:token/dashboard`. */
  readonly dashboard: SharedDashboardDto;
  readonly source: SharedDashboardSource;
  /** `?embed=1`: framed by another site (no page chrome). */
  readonly embed: boolean;
  /** A request ended the page: link revoked or turned off, unlock expired… */
  readonly onFatal: (error: unknown) => void;
}

export interface SharePageParts {
  /**
   * (T814) A dashboard link: the dashboard renderer (`features/dashboard`,
   * ECharts), a chunk of its own — never part of the view or board chunks.
   */
  readonly Dashboard: ComponentType<SharedDashboardProps>;
  /** The form a person fills in (T315). */
  readonly FormRenderer: FormRendererComponent;
  /**
   * Windowed rows of the shared grid: loaded with the grid only (a form or
   * board link never needs them). Always the same promise, for `use()`.
   */
  readonly loadWindowedRows: () => Promise<UseWindowedRows>;
  /** Filter, sort and search controls of the view toolbar (T311), for viewers allowed to. */
  readonly Toolbar: ViewToolbarComponents;
  /** Files of an attachment cell with the viewer (T418 screens, read-only; T409). */
  readonly Files: ComponentType<ReadOnlyFilesProps>;
  /**
   * The viewer alone, opened from a grid cell or a card (T419): files can be
   * seen (and downloaded with `allow_download`) without the record detail.
   */
  readonly FileViewer: ComponentType<ReadOnlyViewerProps>;
}
