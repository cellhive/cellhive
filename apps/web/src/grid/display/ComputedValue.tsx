import { formatComputedText, type LocaleContext } from '@cellhive/field-types';
import { cn } from '@cellhive/ui';
import { Check, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { computedCellShape, hyperlinkOf, type ComputedColumn } from './computed';

import type { GridField } from '../types';
import type { ReactNode } from 'react';

export interface ComputedValueProps {
  readonly field: GridField;
  readonly computed: ComputedColumn;
  readonly value: unknown;
  readonly locale: LocaleContext;
  readonly empty?: ReactNode;
  readonly compact?: boolean | undefined;
  readonly links?: boolean | undefined;
  readonly className?: string | undefined;
  /** Draws a value as another field type would (users, linked records, files). */
  readonly renderAs: (field: GridField, value: unknown) => ReactNode;
}

/** How users and files of a result are drawn: like a user field (several) and an attachment field. */
const USER_CONFIG = { type: 'user', options: { multiple: true } } as GridField['config'];
const ATTACHMENT_CONFIG = { type: 'attachment', options: {} } as unknown as GridField['config'];

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * A formula/lookup value in the DOM (T468: record panel, card list,
 * embedded tables, share page details) — the DOM twin of
 * `cellRenderers/computed.ts`: a lock when the reader cannot read the
 * source, the grey token of a field-level error, "…" while a new field is
 * computed, else the value by result type and style (dimmed while
 * recomputing); a `HYPERLINK` label links only to http/https/mailto.
 */
export function ComputedValue({
  field,
  computed,
  value,
  locale,
  empty,
  compact,
  links = true,
  className,
  renderAs,
}: ComputedValueProps) {
  const { t } = useTranslation('grid');
  const shape = computedCellShape(computed, value);
  const wrap = cn(
    'min-w-0',
    compact === true ? 'truncate' : 'break-words whitespace-pre-wrap',
    className,
  );
  switch (shape.kind) {
    case 'locked':
      return (
        <span
          className={cn(wrap, 'inline-flex items-center gap-1 text-fg-muted')}
          data-testid="computed-locked"
        >
          <Lock aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{t('computed.lockedShort')}</span>
          <span className="sr-only">{`: ${t('computed.lockedCell')}`}</span>
        </span>
      );
    case 'error':
      return (
        <span
          className={cn(wrap, 'font-mono text-mono text-fg-subtle')}
          data-testid="computed-error"
        >
          {shape.token}
          <span className="sr-only">{` (${t('computed.errorCell')})`}</span>
        </span>
      );
    case 'pending':
      return (
        <span className={cn(wrap, 'text-fg-subtle')}>
          <span aria-hidden="true">…</span>
          <span className="sr-only">{t('computed.pendingCell')}</span>
        </span>
      );
    case 'value':
      break;
  }
  // Dimmed by color, not opacity: the text keeps its 4.5:1 contrast (axe).
  const dim = shape.dim ? 'text-fg-muted' : undefined;
  if (isEmpty(value)) {
    return empty === undefined ? null : <span className={wrap}>{empty}</span>;
  }
  const resultType = computed.resultType;
  if (resultType === null) {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return <span className={cn(wrap, dim)}>{text}</span>;
  }
  switch (resultType.kind) {
    case 'user':
      return (
        <span className={cn('min-w-0', dim)}>
          {renderAs({ field: field.field, config: USER_CONFIG }, value)}
        </span>
      );
    case 'attachment':
      return (
        <span className={cn('min-w-0', dim)}>
          {renderAs({ field: field.field, config: ATTACHMENT_CONFIG }, value)}
        </span>
      );
    case 'record':
      return (
        <span className={cn('min-w-0', dim)}>
          {renderAs({ field: field.field, config: null }, value)}
        </span>
      );
    default:
      break;
  }
  if (resultType.list) {
    const scalar = { kind: resultType.kind, list: false } as const;
    const items = (Array.isArray(value) ? value : [value])
      .map((item) => formatComputedText(item, scalar, computed.style, locale))
      .filter((text) => text !== '');
    const shown = compact === true ? items.slice(0, 1) : items;
    return (
      <span
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-1',
          compact === true && 'flex-nowrap overflow-hidden',
          dim,
          className,
        )}
      >
        {shown.map((text, index) => (
          <span
            key={`${text}-${String(index)}`}
            className={cn(
              'rounded-sm bg-surface-sunken px-1.5 text-label leading-5 font-normal',
              compact === true && 'min-w-0 truncate whitespace-nowrap',
            )}
          >
            {text}
          </span>
        ))}
        {items.length > shown.length ? (
          <span className="shrink-0 rounded-sm bg-surface-sunken px-1.5 text-label leading-5 text-fg-muted tabular-nums">
            {`+${String(items.length - shown.length)}`}
          </span>
        ) : null}
      </span>
    );
  }
  if (resultType.kind === 'boolean') {
    // A check box (S4b decision #12): checked shows the check, unchecked nothing.
    return value === true ? (
      <span className={cn('inline-flex items-center gap-1 text-accent', dim)}>
        <Check aria-hidden="true" className="size-4" />
        <span className="sr-only">{t('value.checked')}</span>
      </span>
    ) : empty === undefined ? null : (
      <span className={wrap}>{empty}</span>
    );
  }
  const text = formatComputedText(value, resultType, computed.style, locale);
  if (resultType.kind === 'text') {
    const link = hyperlinkOf(text);
    if (link !== null) {
      if (link.href === null || !links) return <span className={cn(wrap, dim)}>{link.label}</span>;
      return (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            wrap,
            'inline-block max-w-full align-middle leading-6',
            'text-accent underline underline-offset-2',
            dim,
          )}
        >
          {link.label}
        </a>
      );
    }
  }
  return (
    <span className={cn(wrap, resultType.kind === 'number' && 'tabular-nums', dim)}>{text}</span>
  );
}
