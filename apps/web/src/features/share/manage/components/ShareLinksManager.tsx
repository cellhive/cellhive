import {
  DEFAULT_LIST_LIMIT,
  SHARE_LINK_AUDIENCES,
  type ShareLinkAudience,
  type ShareLinkDto,
  type ShareLinkTargetType,
} from '@cellhive/contracts';
import { Button, FormField, Select, Skeleton, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { showToast } from '../../../../lib/toast/toast';
import { shareLinkListQuery, useRevokeLinks, type LinkScope, type OrgLinkFilters } from '../api';
import { accessSummary } from '../stats';

import { StatusBadge } from './StatusBadge';

/** Target types a link can have in this release (dashboards come in S7). */
const TARGET_TYPES: readonly ShareLinkTargetType[] = ['view', 'form'];
const PAGE_SIZE = DEFAULT_LIST_LIMIT;
/** `<option>` values of the "State" filter (`?enabled=`). */
const ENABLED_VALUES = { on: 'true', off: 'false' } as const;

/** Below `sm` (640 px) the table gives way to a list of cards (T322a). */
const NARROW_QUERY = '(max-width: 639.98px)';

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

interface Filters {
  audience: ShareLinkAudience | '';
  targetType: ShareLinkTargetType | '';
  enabled: 'true' | 'false' | '';
  baseId: string;
}

const NO_FILTERS: Filters = { audience: '', targetType: '', enabled: '', baseId: '' };

function toQuery(filters: Filters, offset: number): OrgLinkFilters {
  return {
    offset,
    limit: PAGE_SIZE,
    ...(filters.audience === '' ? {} : { audience: filters.audience }),
    ...(filters.targetType === '' ? {} : { target_type: filters.targetType }),
    ...(filters.enabled === '' ? {} : { enabled: filters.enabled === 'true' }),
    // Ids come from the base list of the API.
    ...(filters.baseId === '' ? {} : { base_id: filters.baseId as `bse_${string}` }),
  };
}

export interface ShareLinksManagerProps {
  readonly scope: LinkScope;
  /** Organization list: base names for the column and the base filter. */
  readonly bases?: readonly { readonly id: string; readonly name: string }[] | undefined;
}

/**
 * The admin list of share links of a base or an organization (T316,
 * FRONTEND §2, CONTRACTS §16): filters (server side), pages of 50, target,
 * audience, creator, last access and status (`blocked` included); select
 * links and revoke them together after a confirmation. Phones (below 640
 * px, T322a): one card per link instead of a table squeezed into columns.
 */
export function ShareLinksManager({ scope, bases }: ShareLinksManagerProps) {
  const { t } = useTranslation('share');
  const format = useFormatters();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const list = useQuery(shareLinkListQuery(scope, toQuery(filters, offset)));
  const revoke = useRevokeLinks(scope);
  const baseNames = new Map(bases?.map((base) => [base.id, base.name]));
  const showBase = scope.kind === 'org';
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);

  const changeFilters = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setOffset(0);
    setSelected(new Set());
  };
  const toggle = (id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const allOnPage = items.length > 0 && items.every((link) => selected.has(link.id));

  return (
    <div className="flex flex-col gap-4">
      <fieldset
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="share-link-filters"
      >
        <legend className="sr-only">{t('filters.label')}</legend>
        <FilterSelect
          label={t('filters.audience')}
          value={filters.audience}
          options={SHARE_LINK_AUDIENCES.map((value) => ({
            value,
            label: t(`list.audiences.${value}`),
          }))}
          onChange={(value) => {
            changeFilters({ audience: value as Filters['audience'] });
          }}
        />
        <FilterSelect
          label={t('filters.type')}
          value={filters.targetType}
          options={TARGET_TYPES.map((value) => ({ value, label: t(`list.types.${value}`) }))}
          onChange={(value) => {
            changeFilters({ targetType: value as Filters['targetType'] });
          }}
        />
        <FilterSelect
          label={t('filters.state')}
          value={filters.enabled}
          options={[
            { value: ENABLED_VALUES.on, label: t('filters.on') },
            { value: ENABLED_VALUES.off, label: t('filters.off') },
          ]}
          onChange={(value) => {
            changeFilters({ enabled: value as Filters['enabled'] });
          }}
        />
        {showBase ? (
          <FilterSelect
            label={t('filters.base')}
            value={filters.baseId}
            options={(bases ?? []).map((base) => ({ value: base.id, label: base.name }))}
            onChange={(value) => {
              changeFilters({ baseId: value });
            }}
          />
        ) : null}
      </fieldset>

      <div className="flex min-h-control flex-wrap items-center gap-3" aria-live="polite">
        {selected.size > 0 ? (
          <>
            <span className="text-body">{t('bulk.selected', { count: selected.size })}</span>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden="true" />
              {t('bulk.revoke')}
            </Button>
          </>
        ) : items.length > 1 ? (
          // The row keeps its height so that ticking a box does not move the list.
          <span aria-hidden="true" className="text-label font-normal text-fg-muted">
            {t('bulk.hint')}
          </span>
        ) : null}
      </div>

      {confirming ? (
        <ConfirmRevoke
          count={selected.size}
          pending={revoke.isPending}
          error={revoke.error}
          onCancel={() => {
            setConfirming(false);
            revoke.reset();
          }}
          onConfirm={() => {
            revoke.mutate([...selected], {
              onSuccess: (result) => {
                showToast({
                  variant: 'success',
                  message: t('bulk.done', { count: result.revoked.length }),
                });
                setSelected(new Set());
                setConfirming(false);
              },
            });
          }}
        />
      ) : null}

      {list.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('list.loading')}</span>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : list.isError ? (
        <ErrorAlert error={list.error} />
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong bg-surface px-6 py-10 text-center text-fg-muted">
          {filtered ? t('list.emptyFiltered') : t('list.empty')}
        </p>
      ) : narrow ? (
        <LinkCards
          items={items}
          selected={selected}
          allOnPage={allOnPage}
          onToggleAll={(on) => {
            setSelected((current) => {
              const next = new Set(current);
              for (const link of items) {
                if (on) next.add(link.id);
                else next.delete(link.id);
              }
              return next;
            });
          }}
          onToggle={toggle}
          baseNameOf={(link) =>
            showBase ? (baseNames.get(link.base_id) ?? t('list.unknownBase')) : null
          }
          lastAccessOf={(link) => accessSummary(t, link, format.dateTime)}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-body" aria-label={t('list.label')}>
            <thead className="border-b border-line text-label text-fg-muted">
              <tr>
                <th scope="col" className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('list.selectAll')}
                    checked={allOnPage}
                    onChange={(event) => {
                      const on = event.target.checked;
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const link of items) {
                          if (on) next.add(link.id);
                          else next.delete(link.id);
                        }
                        return next;
                      });
                    }}
                    className="size-4 accent-accent"
                  />
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('list.target')}
                </th>
                {showBase ? (
                  <th scope="col" className="px-3 py-2">
                    {t('list.base')}
                  </th>
                ) : null}
                <th scope="col" className="px-3 py-2">
                  {t('list.audience')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('list.createdBy')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('list.lastAccess')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('list.status')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  selected={selected.has(link.id)}
                  onToggle={(on) => {
                    toggle(link.id, on);
                  }}
                  baseName={
                    showBase ? (baseNames.get(link.base_id) ?? t('list.unknownBase')) : null
                  }
                  lastAccess={accessSummary(t, link, format.dateTime)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE ? (
        <nav aria-label={t('list.pagination')} className="flex items-center justify-end gap-2">
          <span className="text-label font-normal text-fg-muted">
            {t('list.page', {
              from: format.number(offset + 1),
              to: format.number(Math.min(offset + PAGE_SIZE, total)),
              total: format.number(total),
            })}
          </span>
          <Button
            variant="secondary"
            size="icon"
            aria-label={t('list.previous')}
            disabled={offset === 0}
            onClick={() => {
              setOffset(Math.max(0, offset - PAGE_SIZE));
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label={t('list.next')}
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => {
              setOffset(offset + PAGE_SIZE);
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('share');
  return (
    <FormField label={label}>
      {(control) => (
        <Select
          {...control}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="">{t('filters.all')}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </FormField>
  );
}

function LinkRow({
  link,
  selected,
  onToggle,
  baseName,
  lastAccess,
}: {
  link: ShareLinkDto;
  selected: boolean;
  onToggle: (on: boolean) => void;
  baseName: string | null;
  lastAccess: string;
}) {
  const { t } = useTranslation('share');
  const name =
    link.target_name ??
    t(link.target_type === 'dashboard' ? 'list.deletedDashboard' : 'list.deletedTarget');
  return (
    <tr data-testid={`share-link-row-${link.id}`}>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          aria-label={t('list.select', { name })}
          checked={selected}
          onChange={(event) => {
            onToggle(event.target.checked);
          }}
          className="size-4 accent-accent"
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col">
          <span className={link.target_name === null ? 'text-fg-muted italic' : 'font-medium'}>
            {name}
          </span>
          <span className="text-label font-normal text-fg-muted">
            {t(`list.types.${link.target_type}`)} ·{' '}
            <span className="font-mono">{link.token_prefix}…</span>
          </span>
        </div>
      </td>
      {baseName === null ? null : <td className="px-3 py-2">{baseName}</td>}
      <td className="px-3 py-2">{t(`list.audiences.${link.audience}`)}</td>
      <td className="px-3 py-2">{link.created_by.name ?? t('list.unknownUser')}</td>
      <td className="px-3 py-2 whitespace-nowrap">{lastAccess}</td>
      <td className="px-3 py-2">
        <StatusBadge status={link.status} />
      </td>
    </tr>
  );
}

/**
 * The links as cards (phones, T322a): the target with its type and token
 * prefix, the status, then audience, creator (and base) and last access;
 * the whole top row of a card is the check box's label (a 44 px target).
 */
function LinkCards({
  items,
  selected,
  allOnPage,
  onToggleAll,
  onToggle,
  baseNameOf,
  lastAccessOf,
}: {
  items: readonly ShareLinkDto[];
  selected: ReadonlySet<string>;
  allOnPage: boolean;
  onToggleAll: (on: boolean) => void;
  onToggle: (id: string, on: boolean) => void;
  baseNameOf: (link: ShareLinkDto) => string | null;
  lastAccessOf: (link: ShareLinkDto) => string;
}) {
  const { t } = useTranslation('share');
  return (
    <div className="flex flex-col gap-2">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-1 text-body text-fg-muted">
        <input
          type="checkbox"
          aria-label={t('list.selectAll')}
          checked={allOnPage}
          onChange={(event) => {
            onToggleAll(event.target.checked);
          }}
          className="size-5 shrink-0 accent-accent"
        />
        <span aria-hidden="true">{t('list.selectAll')}</span>
      </label>
      <ul aria-label={t('list.label')} className="flex flex-col gap-2">
        {items.map((link) => {
          const name =
            link.target_name ??
            t(link.target_type === 'dashboard' ? 'list.deletedDashboard' : 'list.deletedTarget');
          const baseName = baseNameOf(link);
          return (
            <li
              key={link.id}
              data-testid={`share-link-row-${link.id}`}
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
            >
              <div className="flex items-start gap-3">
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={t('list.select', { name })}
                    checked={selected.has(link.id)}
                    onChange={(event) => {
                      onToggle(link.id, event.target.checked);
                    }}
                    className="mt-0.5 size-5 shrink-0 accent-accent"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={
                        link.target_name === null
                          ? 'break-words text-fg-muted italic'
                          : 'font-medium break-words'
                      }
                    >
                      {name}
                    </span>
                    <span className="text-label font-normal text-fg-muted">
                      {t(`list.types.${link.target_type}`)} ·{' '}
                      <span className="font-mono">{link.token_prefix}…</span>
                    </span>
                  </span>
                </label>
                <StatusBadge status={link.status} />
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 pl-8 text-label font-normal">
                {baseName === null ? null : (
                  <>
                    <dt className="text-fg-muted">{t('list.base')}</dt>
                    <dd className="min-w-0 break-words text-fg">{baseName}</dd>
                  </>
                )}
                <dt className="text-fg-muted">{t('list.audience')}</dt>
                <dd className="text-fg">{t(`list.audiences.${link.audience}`)}</dd>
                <dt className="text-fg-muted">{t('list.createdBy')}</dt>
                <dd className="min-w-0 break-words text-fg">
                  {link.created_by.name ?? t('list.unknownUser')}
                </dd>
                <dt className="text-fg-muted">{t('list.lastAccess')}</dt>
                <dd className="text-fg">{lastAccessOf(link)}</dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Confirmation of a bulk revoke (a modal dialog would hide the selection it is about). */
function ConfirmRevoke({
  count,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  count: number;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('share');
  const titleId = useId();
  const descriptionId = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmButton.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="flex flex-col gap-2 rounded-md border border-danger bg-surface px-4 py-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <p id={titleId} className="font-semibold">
        {t('bulk.title', { count })}
      </p>
      <p id={descriptionId}>{t('bulk.description')}</p>
      {error === null ? null : <ErrorAlert error={error} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t('actions.cancel')}
        </Button>
        <Button ref={confirmButton} variant="danger" disabled={pending} onClick={onConfirm}>
          {pending ? <Spinner /> : null}
          {t('bulk.confirm')}
        </Button>
      </div>
    </div>
  );
}
