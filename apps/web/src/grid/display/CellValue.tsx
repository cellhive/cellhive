import {
  FIELD_TYPE_REGISTRY,
  isInvalidForTextStyle,
  type LocaleContext,
} from '@cellhive/field-types';
import { cn } from '@cellhive/ui';
import { Check, Lock, Paperclip, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cellFilesOf } from '../../lib/attachments/value';
import { buttonViewOf } from '../../lib/buttons/model';
import { OptionChip } from '../editors/picker';

import { Avatar } from './Avatar';
import { ButtonPill } from './ButtonValue';
import { ComputedValue } from './ComputedValue';
import { initialsOf, linkTarget } from './text';

import type { GridField } from '../types';
import type { ReactNode } from 'react';

/**
 * A cell value in the DOM (record panel, history, card list), in the json
 * read shape of CONTRACTS §2. Values of the history may name options,
 * users and records that were deleted since: `{ id, name: null, deleted:
 * true }` (CONTRACTS §11.1) reads "Deleted option" / "Deleted user", struck
 * through. Glide-free, so screens outside the grid chunk can use it.
 */
export interface CellValueProps {
  readonly field: GridField;
  readonly value: unknown;
  readonly locale: LocaleContext;
  /** Shown for an empty value (default: nothing). */
  readonly empty?: ReactNode;
  /** One line, truncated (card list); default wraps. */
  readonly compact?: boolean;
  /**
   * Url/email/phone values as links (default). `false` inside something
   * already clickable — a card button, a sub-table cell button (T421b: no
   * nested interactive element, no tiny target next to the row's own).
   */
  readonly links?: boolean;
  readonly className?: string;
}

interface Ref {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly email?: unknown;
  readonly title?: unknown;
  readonly deleted?: unknown;
}

function isRef(value: unknown): value is Ref {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function Deleted({ children }: { children: ReactNode }) {
  return <s className="text-fg-muted">{children}</s>;
}

function UserBadge({ id, name }: { id: string; name: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      <Avatar colorKey={id} size="md">
        {name === '' ? '?' : initialsOf(name)}
      </Avatar>
      <span className="truncate">{name}</span>
    </span>
  );
}

function formatText(field: GridField, value: unknown, locale: LocaleContext): string {
  const config = field.config;
  if (config === null) {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '✓' : '';
    return '';
  }
  return (
    FIELD_TYPE_REGISTRY[config.type] as {
      formatText: (value: unknown, options: unknown, ctx: LocaleContext) => string;
    }
  ).formatText(value, config.options, locale);
}

export function CellValue({
  field,
  value,
  locale,
  empty,
  compact,
  className,
  links = true,
}: CellValueProps) {
  const { t } = useTranslation('grid');
  const wrap = cn(
    'min-w-0',
    compact === true ? 'truncate' : 'break-words whitespace-pre-wrap',
    className,
  );
  // Button (T525): the button as the server's state shows it; pressed in the grid and the panel.
  if (field.button !== undefined) {
    return (
      <ButtonPill
        label={field.button.label}
        color={field.button.color}
        view={buttonViewOf(value)}
        {...(className === undefined ? {} : { className })}
      />
    );
  }
  // Formula / lookup (T468): locks, error tokens and values by result type.
  if (field.computed !== undefined) {
    return (
      <ComputedValue
        field={field}
        computed={field.computed}
        value={value}
        locale={locale}
        empty={empty}
        compact={compact}
        links={links}
        className={className}
        renderAs={(as, shown) => (
          <CellValue
            field={as}
            value={shown}
            locale={locale}
            links={links}
            {...(compact === undefined ? {} : { compact })}
            {...(className === undefined ? {} : { className })}
          />
        )}
      />
    );
  }
  if (isEmpty(value)) return empty === undefined ? null : <span className={wrap}>{empty}</span>;
  const config = field.config;
  const items = Array.isArray(value) ? (value as unknown[]) : [value];
  const list = (children: ReactNode) => (
    <span
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-1',
        compact === true && 'flex-nowrap overflow-hidden',
        className,
      )}
    >
      {children}
    </span>
  );

  if (config === null) {
    // Types without a renderer yet (link, lookup… S4): titles, or a lock without access.
    if (items.some(isRef)) {
      const refs = items.filter(isRef);
      // One line (sub-table, cards): the first chip, cut, then "+N" like the grid (T421a).
      const shown = compact === true ? refs.slice(0, 1) : refs;
      const more = refs.length - shown.length;
      return list([
        ...shown.map((item, index) => {
          const key = typeof item.id === 'string' ? item.id : String(index);
          const label =
            typeof item.title === 'string'
              ? item.title
              : typeof item.name === 'string'
                ? item.name
                : null;
          if (item.deleted === true) return <Deleted key={key}>{t('value.deletedRecord')}</Deleted>;
          return label === null ? (
            <span key={key} className="inline-flex items-center gap-1 text-fg-muted">
              <Lock aria-hidden="true" className="size-3.5" />
              {t('value.noAccess')}
            </span>
          ) : (
            <span
              key={key}
              className={cn(
                'rounded-sm bg-surface-sunken px-1.5 text-label leading-5',
                compact === true && 'min-w-0 truncate whitespace-nowrap',
              )}
            >
              {label}
            </span>
          );
        }),
        ...(more > 0
          ? [
              <span
                key="more"
                className="shrink-0 rounded-sm bg-surface-sunken px-1.5 text-label leading-5 text-fg-muted tabular-nums"
              >
                <span aria-hidden="true">+{more}</span>
                <span className="sr-only">{t('value.moreLinks', { count: more })}</span>
              </span>,
            ]
          : []),
      ]);
    }
    return <span className={wrap}>{formatText(field, value, locale)}</span>;
  }

  switch (config.type) {
    case 'select': {
      const colors = new Map(
        config.options.options.map((option, index) => [option.name, option.color ?? index]),
      );
      return list(
        items.map((item, index) =>
          typeof item === 'string' ? (
            <OptionChip
              key={`${item}-${String(index)}`}
              name={item}
              color={colors.get(item) ?? 0}
            />
          ) : (
            <Deleted key={`deleted-${String(index)}`}>{t('value.deletedOption')}</Deleted>
          ),
        ),
      );
    }
    case 'user':
    case 'created_by':
    case 'updated_by':
      return list(
        items.filter(isRef).map((item, index) => {
          const id = typeof item.id === 'string' ? item.id : String(index);
          if (item.deleted === true) return <Deleted key={id}>{t('value.deletedUser')}</Deleted>;
          const name =
            typeof item.name === 'string' && item.name !== ''
              ? item.name
              : typeof item.email === 'string'
                ? item.email
                : t('formerMember');
          return <UserBadge key={id} id={id} name={name} />;
        }),
      );
    case 'attachment':
      // File names (T418): no image is loaded here (history, cards, lists).
      return list(
        cellFilesOf(value).map((file) => (
          <span
            key={file.id}
            className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm bg-surface-sunken px-1.5 text-label leading-5 font-normal"
          >
            <Paperclip aria-hidden="true" className="size-3 shrink-0 text-fg-muted" />
            <span className="truncate">{file.name}</span>
          </span>
        )),
      );
    case 'checkbox':
      return value === true ? (
        <span className="inline-flex items-center gap-1 text-accent">
          <Check aria-hidden="true" className="size-4" />
          <span className="sr-only">{t('value.checked')}</span>
        </span>
      ) : empty === undefined ? null : (
        <span className={wrap}>{empty}</span>
      );
    case 'text': {
      const text = formatText(field, value, locale);
      const style = config.options.style.type;
      // T414 (SPEC §5.5 item 5): a value in the wrong email/phone format is kept, marked.
      if ((style === 'email' || style === 'phone') && isInvalidForTextStyle(text, style)) {
        return (
          <span className={cn(wrap, 'inline-flex items-start gap-1 text-danger')}>
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {text}
              <span className="sr-only"> ({t(`invalidFormat.${style}`)})</span>
            </span>
          </span>
        );
      }
      const href = links ? linkTarget(style, text) : null;
      if (href !== null) {
        return (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            // A 24 px tall target (WCAG 2.5.8) wherever the value shows (cells, record panel; T470).
            className={cn(
              wrap,
              'inline-block max-w-full align-middle leading-6',
              'text-accent underline underline-offset-2',
            )}
          >
            {text}
          </a>
        );
      }
      return <span className={cn(wrap, style === 'barcode' && 'font-mono text-mono')}>{text}</span>;
    }
    default: {
      const text = formatText(field, value, locale);
      const numeric = config.type === 'number' || config.type === 'auto_number';
      return (
        <span
          className={cn(
            wrap,
            numeric && 'tabular-nums',
            config.type === 'auto_number' && 'font-mono text-mono',
          )}
        >
          {text}
        </span>
      );
    }
  }
}
