import { Button, Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Maximize2, Table2, Unlink } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { tablesQuery } from '../../../lib/query/queries';
import { RECORD_PARAM } from '../../../lib/records/detail';
import { displayValues, useLinkCandidates, useLinkedFields } from '../use-candidates';

import type { LinkHoverCardProps } from '../../../lib/links/picker';

const WIDTH = 320;
const MARGIN = 8;

/**
 * Quick look at a linked record (board "Ô liên kết trong grid"): the
 * linked table, the title, up to three fields the user reads (the
 * candidates API with `ids`, so the user's rights apply), "Open record" (the
 * linked table with `?record=`) and "Unlink" when the cell is editable. A
 * pointer surface: it stays while the pointer is on it; keyboard users open
 * the record panel (Space) instead.
 */
export function LinkHoverCard(props: LinkHoverCardProps) {
  const { t } = useTranslation('link');
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const linkTable = props.options.link_table;
  const ids = useMemo(() => [props.recordId], [props.recordId]);
  const candidates = useLinkCandidates({
    fieldId: props.field.id,
    linkTable,
    recordId: null,
    search: '',
    ids,
  });
  const fields = useLinkedFields(linkTable);
  const tables = useQuery(tablesQuery(props.baseId));
  const tableName = tables.data?.items.find((table) => table.id === linkTable)?.name ?? '';
  const item = candidates.items[0];
  const values =
    item === undefined
      ? []
      : displayValues(item, candidates.displayFields, fields.data?.items, props.locale);

  const [top, setTop] = useState(props.anchor.y + props.anchor.height + 4);
  useLayoutEffect(() => {
    const height = box.current?.offsetHeight ?? 0;
    const below = props.anchor.y + props.anchor.height + 4;
    setTop(
      below + height <= window.innerHeight - MARGIN
        ? below
        : Math.max(MARGIN, props.anchor.y - 4 - height),
    );
  }, [props.anchor, item, values.length]);
  const left = Math.max(MARGIN, Math.min(props.anchor.x, window.innerWidth - WIDTH - MARGIN));
  const title = item?.title ?? '';
  const gone =
    candidates.status === 'error' || (candidates.status === 'success' && item === undefined);

  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-label={t('card.label', { title })}
      data-testid="link-hover-card"
      className="fixed z-40 flex animate-pop-in flex-col rounded-lg border border-line bg-surface text-body text-fg shadow-popover"
      style={{ left, top, width: WIDTH }}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose();
      }}
    >
      <div className="flex flex-col gap-0.5 border-b border-line px-3.5 pt-3 pb-2.5">
        <span className="flex items-center gap-1.5 text-label font-normal text-fg-muted">
          <Table2 aria-hidden="true" className="size-[13px]" />
          {tableName}
        </span>
        {candidates.status === 'pending' ? (
          <Skeleton className="mt-1 h-4 w-2/3" />
        ) : gone ? (
          <span className="text-body text-fg-muted">{t('card.gone')}</span>
        ) : (
          <span className="text-heading">{title}</span>
        )}
      </div>
      {candidates.status === 'pending' ? (
        <div
          className="flex flex-col gap-2 px-3.5 py-2.5"
          role="status"
          aria-label={t('card.loading')}
        >
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : values.length > 0 ? (
        <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] items-center gap-y-2 px-3.5 py-2.5">
          {values.map((value) => (
            <div key={value.fieldId} className="contents">
              <dt className="truncate text-label font-normal text-fg-muted">{value.name}</dt>
              <dd
                className={
                  value.code ? 'm-0 truncate font-mono text-mono' : 'm-0 truncate tabular-nums'
                }
              >
                {value.text}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="flex gap-1.5 border-t border-line px-2.5 py-2">
        {gone ? null : (
          <Button
            variant="secondary"
            size="sm"
            data-testid="link-card-open"
            onClick={() => {
              props.onClose();
              void navigate(
                `/b/${props.baseId}/t/${linkTable}?${RECORD_PARAM}=${encodeURIComponent(props.recordId)}`,
              );
            }}
          >
            <Maximize2 aria-hidden="true" />
            {t('card.open')}
          </Button>
        )}
        {props.onUnlink === undefined ? null : (
          <Button
            variant="ghost"
            size="sm"
            data-testid="link-card-unlink"
            onClick={() => {
              props.onUnlink?.();
              props.onClose();
            }}
          >
            <Unlink aria-hidden="true" />
            {t('card.unlink')}
          </Button>
        )}
      </div>
    </div>
  );
}
