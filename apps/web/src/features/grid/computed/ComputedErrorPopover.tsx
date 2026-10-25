import { Button, cn, Spinner } from '@cellhive/ui';
import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { useFormatters } from '../../../lib/i18n/format';

import type { ComputedErrorDetails } from './error-model';
import type { HeaderMenuAnchor } from '../../../grid';

const WIDTH = 320;
const GAP = 4;
const MARGIN = 8;

export interface ComputedErrorPopoverProps {
  readonly fieldName: string;
  readonly type: 'formula' | 'lookup';
  readonly details: ComputedErrorDetails;
  /** The column header: the popover opens under its right end. */
  readonly anchor: HeaderMenuAnchor;
  /** Schema rights on the table: the actions; others read who can fix it. */
  readonly canManage: boolean;
  readonly busy: 'restore' | 'retry' | null;
  readonly onRestore: (fieldId: string) => void;
  readonly onEdit: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

/**
 * Details of a field-level error of a computed column (T468, board "S4b ·
 * Cột tính toán: lỗi và tính lại"): the token and what it means, the
 * objects named (only those the reader sees, CONTRACTS §13 `refs`) and the
 * way out — "Restore field" (a referenced field of this table in the
 * trash), "Edit formula", "Retry" (`TIMEOUT`). A non-modal popover on the
 * inverse surface (it holds buttons: not a tooltip, FRONTEND §9.2); Escape
 * or a click outside closes it and the focus goes back.
 */
export function ComputedErrorPopover({
  fieldName,
  type,
  details,
  anchor,
  canManage,
  busy,
  onRestore,
  onEdit,
  onRetry,
  onClose,
}: ComputedErrorPopoverProps) {
  const { t } = useTranslation('grid');
  const format = useFormatters();
  const titleId = useId();
  const box = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(160);

  useLayoutEffect(() => {
    const element = box.current;
    if (element !== null) setHeight(element.offsetHeight);
  }, [details]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && box.current?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
  const left = Math.min(
    Math.max(anchor.x + anchor.width - width, MARGIN),
    window.innerWidth - width - MARGIN,
  );
  const below = anchor.y + anchor.height + GAP;
  const top =
    below + height <= window.innerHeight - MARGIN
      ? below
      : Math.max(MARGIN, anchor.y - GAP - height);

  const subject = t(`computed.subject.${type}`);
  const what = t(`computed.what.${type}`);
  const names = details.names.join(', ');
  const body = (() => {
    const values = {
      subject,
      what,
      names,
      token: details.token,
      when: details.deletedAt === null ? '' : format.dateTime(details.deletedAt),
    };
    const key =
      details.variant === 'deleted' && details.deletedAt !== null
        ? 'computed.error.deletedAt'
        : `computed.error.${details.variant}`;
    return (
      <Trans
        t={t}
        i18nKey={key as 'computed.error.deleted'}
        values={values}
        components={{ b: <strong className="font-semibold" /> }}
      />
    );
  })();

  return (
    <section
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="computed-error-popover"
      className="fixed z-50 flex flex-col gap-2 rounded-lg bg-inverse px-3 py-2.5 text-label leading-normal font-normal text-on-inverse shadow-popover outline-none animate-pop-in"
      style={{ left, top, width }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <h2 id={titleId} className="flex min-w-0 flex-1 items-center gap-1.5 font-semibold">
          <span className="font-mono">{details.token}</span>
          <span className="min-w-0">{t(`computed.title.${details.code}`)}</span>
          <span className="sr-only">{`: ${fieldName}`}</span>
        </h2>
        <button
          type="button"
          aria-label={t('computed.close')}
          className="-mt-1 -mr-1.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-on-inverse hover:bg-on-inverse/15 focus-visible:outline-2 focus-visible:outline-on-inverse"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <p>{body}</p>
      {canManage ? (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {details.restorable.map((ref) => (
            <Button
              key={ref.id}
              size="sm"
              className="bg-on-inverse text-inverse hover:bg-on-inverse/90"
              disabled={busy !== null}
              onClick={() => {
                onRestore(ref.id);
              }}
              data-testid="computed-restore-field"
            >
              {busy === 'restore' ? <Spinner /> : null}
              {details.restorable.length === 1
                ? t('computed.actions.restore')
                : t('computed.actions.restoreNamed', { name: ref.name })}
            </Button>
          ))}
          {details.retry ? (
            <Button
              size="sm"
              className="bg-on-inverse text-inverse hover:bg-on-inverse/90"
              disabled={busy !== null}
              onClick={onRetry}
              data-testid="computed-retry"
            >
              {busy === 'retry' ? <Spinner /> : null}
              {t('computed.actions.retry')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              'border border-on-inverse/50 text-on-inverse hover:bg-on-inverse/15 hover:text-on-inverse',
            )}
            disabled={busy !== null}
            onClick={onEdit}
          >
            {t(`computed.actions.edit.${type}`)}
          </Button>
        </div>
      ) : (
        <p className="text-on-inverse/80">{t('computed.askManager')}</p>
      )}
    </section>
  );
}
