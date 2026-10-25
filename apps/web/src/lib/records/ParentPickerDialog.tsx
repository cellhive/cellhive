import { Button, cn, Dialog, Input } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Check, CornerUpLeft, RotateCw, Search, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api';
import { recordTreeApi } from '../api/record-tree';
import { ErrorAlert } from '../errors/ErrorAlert';
import { keys } from '../query/keys';

import type { RecordDto } from '@cellhive/contracts';

/** Most levels of a sub-record tree (CONTRACTS §1.4, `SUBRECORD_MAX_LEVELS`). */
const MAX_LEVELS = 10;
/** Candidates listed at once: the first 20 matches of the search. */
const CANDIDATE_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 250;
/** Widths of the loading rows (board "đang tải": grey bars of varied length). */
const SKELETON_WIDTHS = ['w-[150px]', 'w-[126px]', 'w-[110px]'];

export interface ParentPickerDialogProps {
  readonly open: boolean;
  readonly tableId: string;
  /** The record that gets a new parent. */
  readonly recordId: string;
  /** Its title, for the dialog heading. */
  readonly recordTitle: string;
  /** The primary field of the table: searched and shown for each candidate. */
  readonly primaryFieldId: string;
  /** The current parent, marked in the list (`null`: the record is a root). */
  readonly currentParentId: string | null;
  /**
   * Writes the new parent (`null`: top level). A rejection (e.g. `422
   * SUBRECORD_TOO_DEEP`) is shown inside the dialog, which stays open.
   */
  readonly onSelect: (parentId: string | null) => Promise<void>;
  readonly onClose: () => void;
}

/** Display text of a primary field value (JSON cell format), `null` when empty. */
function titleText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(titleText).filter((part) => part !== null);
    return parts.length === 0 ? null : parts.join(', ');
  }
  if (typeof value === 'object' && value !== null) {
    const { name, title } = value as { name?: unknown; title?: unknown };
    if (typeof title === 'string' && title !== '') return title;
    if (typeof name === 'string' && name !== '') return name;
  }
  return null;
}

type Refusal =
  | { readonly kind: 'cycle'; readonly id: string; readonly title: string }
  | { readonly kind: 'depth'; readonly id: string }
  | { readonly kind: 'server'; readonly id: string | null; readonly error: unknown };

/**
 * "Change parent…" of a sub-record (T417; the record panel and the grid's
 * row menu): a search on the primary field, "No parent" first, then the
 * first 20 matches. A candidate that is a descendant of the record, or too
 * deep for it, is refused here before any write (design board "Cây · chặn
 * vòng lặp khi đổi cha"); the server checks again (`SUBRECORD_CYCLE`,
 * `SUBRECORD_TOO_DEEP`) and its refusal is shown the same way.
 */
export function ParentPickerDialog(props: ParentPickerDialogProps) {
  const { t } = useTranslation('record');
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t('parentPicker.title', { title: props.recordTitle })}
      closeLabel={t('parentPicker.close')}
    >
      <PickerBody {...props} />
    </Dialog>
  );
}

function PickerBody({
  tableId,
  recordId,
  primaryFieldId,
  currentParentId,
  onSelect,
  onClose,
}: ParentPickerDialogProps) {
  const { t } = useTranslation('record');
  const inputId = useId();
  const listId = useId();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [busy, setBusy] = useState<string | null | undefined>(undefined);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(search.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [search]);

  const candidates = useQuery({
    // Under the table prefix: a schema change of the table refetches it.
    queryKey: [...keys.table(tableId), 'parent-candidates', primaryFieldId, debounced],
    queryFn: ({ signal }) =>
      api.records.query(
        tableId,
        {
          search: debounced === '' ? null : debounced,
          offset: 0,
          limit: CANDIDATE_LIMIT,
          fields: [primaryFieldId],
          include_total: false,
        },
        { signal },
      ),
    select: (list) => list.records.filter((item) => item.id !== recordId),
  });

  const titleOf = (item: RecordDto) => titleText(item.fields[primaryFieldId]) ?? t('untitled');

  const choose = async (parentId: string | null, title: string) => {
    setRefusal(null);
    setBusy(parentId);
    try {
      if (parentId !== null) {
        const { items } = await recordTreeApi.ancestors(tableId, parentId);
        if (items.some((ancestor) => ancestor.id === recordId)) {
          setRefusal({ kind: 'cycle', id: parentId, title });
          return;
        }
        // The candidate sits at level `items.length + 1`; the record would be one below.
        if (items.length + 2 > MAX_LEVELS) {
          setRefusal({ kind: 'depth', id: parentId });
          return;
        }
      }
      await onSelect(parentId);
      onClose();
    } catch (error) {
      setRefusal({ kind: 'server', id: parentId, error });
    } finally {
      setBusy(undefined);
    }
  };

  const optionClass = (dimmed: boolean) =>
    cn(
      // 44 px touch targets below 1024 px, 36 px rows above (FRONTEND §9.3).
      'flex min-h-control w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-body lg:min-h-9',
      'hover:bg-surface-sunken focus-visible:bg-surface-sunken disabled:cursor-not-allowed',
      dimmed && 'text-fg-muted',
    );
  const currentMark = (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-label font-normal text-fg-muted">
      <Check aria-hidden="true" className="size-3.5" />
      {t('parentPicker.current')}
    </span>
  );

  let results;
  if (candidates.isPending) {
    results = (
      <div aria-busy="true" className="flex flex-col" data-testid="parent-picker-loading">
        <span className="sr-only">{t('parentPicker.loading')}</span>
        {SKELETON_WIDTHS.map((width) => (
          <div key={width} aria-hidden="true" className="flex h-11 items-center gap-3 px-3">
            <span className="flex flex-col gap-1.5">
              <span className={cn('block h-2.5 rounded-sm bg-surface-sunken', width)} />
              <span className="block h-2 w-[90px] rounded-sm bg-surface-sunken" />
            </span>
          </div>
        ))}
      </div>
    );
  } else if (candidates.isError) {
    results = (
      <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-center">
        <TriangleAlert aria-hidden="true" className="size-5 text-fg-muted" />
        <p className="font-medium">{t('parentPicker.loadFailed')}</p>
        <p className="text-label font-normal text-fg-muted">{t('parentPicker.loadFailedHint')}</p>
        <Button
          variant="secondary"
          size="toolbar"
          className="mt-1 px-2.5"
          onClick={() => {
            void candidates.refetch();
          }}
        >
          <RotateCw aria-hidden="true" />
          {t('parentPicker.retry')}
        </Button>
      </div>
    );
  } else if (candidates.data.length === 0) {
    results = (
      <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-center">
        <Search aria-hidden="true" className="size-5 text-fg-muted" />
        <p className="font-medium">
          {debounced === ''
            ? t('parentPicker.emptyTable')
            : t('parentPicker.noMatch', { search: debounced })}
        </p>
      </div>
    );
  } else {
    results = candidates.data.map((item) => {
      const title = titleOf(item);
      const refused = refusal !== null && refusal.kind !== 'server' && refusal.id === item.id;
      const isCycle = refused && refusal.kind === 'cycle';
      return (
        <li key={item.id}>
          <button
            type="button"
            className={optionClass(refused)}
            disabled={busy !== undefined}
            aria-current={item.id === currentParentId ? 'true' : undefined}
            onClick={() => {
              void choose(item.id, title);
            }}
          >
            <span className="min-w-0 truncate">{title}</span>
            {isCycle ? (
              <span className="ml-auto shrink-0 text-label font-normal text-fg-muted">
                {t('parentPicker.isDescendant')}
              </span>
            ) : item.id === currentParentId ? (
              currentMark
            ) : null}
          </button>
        </li>
      );
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={inputId}
        className="flex items-center gap-2 rounded-md border border-line-control bg-surface px-2.5 focus-within:outline-2 focus-within:outline-accent"
      >
        <Search aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
        <span className="sr-only">{t('parentPicker.search')}</span>
        <Input
          id={inputId}
          type="search"
          value={search}
          placeholder={t('parentPicker.searchPlaceholder')}
          aria-controls={listId}
          className="border-0 px-0 outline-none focus-visible:outline-none"
          onChange={(event) => {
            setSearch(event.target.value);
            setRefusal(null);
          }}
        />
      </label>
      {refusal === null ? null : refusal.kind === 'server' ? (
        <ErrorAlert error={refusal.error} />
      ) : (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-label font-normal"
        >
          <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-danger" />
          <p>
            <strong className="font-semibold text-fg">{t('parentPicker.refusedTitle')}</strong>{' '}
            <span className="text-fg-muted">
              {refusal.kind === 'cycle'
                ? t('parentPicker.cycle', { title: refusal.title })
                : t('parentPicker.tooDeep', { limit: MAX_LEVELS })}
            </span>
          </p>
        </div>
      )}
      <ul
        id={listId}
        aria-label={t('parentPicker.results')}
        aria-busy={candidates.isFetching}
        className="flex max-h-80 flex-col overflow-y-auto"
      >
        <li>
          <button
            type="button"
            className={optionClass(false)}
            disabled={busy !== undefined}
            aria-current={currentParentId === null ? 'true' : undefined}
            onClick={() => {
              void choose(null, '');
            }}
          >
            <CornerUpLeft aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
            <span className="min-w-0 truncate">{t('parentPicker.none')}</span>
            {currentParentId === null ? currentMark : null}
          </button>
        </li>
        {candidates.isPending || candidates.isError || candidates.data.length === 0 ? (
          <li>{results}</li>
        ) : (
          results
        )}
      </ul>
    </div>
  );
}
