import {
  AUDIT_VIA_KINDS,
  MAX_AUDIT_FILTER_VALUES,
  type AuditActionPrefix,
  type AuditViaKind,
} from '@cellhive/contracts';
import {
  Button,
  cn,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FormField,
  Input,
} from '@cellhive/ui';
import { ChevronDown, X } from 'lucide-react';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ACTION_CATEGORIES,
  DEFAULT_FILTERS,
  ENTITY_TYPES,
  RANGE_PRESETS,
  dayOf,
  hasNarrowingFilters,
  prefixKey,
  startOfDay,
  type AuditFilters,
  type RangePreset,
} from '../model';

import { useActionLabel } from './labels';

export interface FilterOption {
  readonly id: string;
  readonly name: string;
  readonly detail?: string | null | undefined;
}

export interface FilterBarProps {
  readonly filters: AuditFilters;
  readonly onChange: (filters: AuditFilters) => void;
  readonly people: readonly FilterOption[];
  /** Organization page: the bases to filter by; `null` on a base page. */
  readonly bases: readonly FilterOption[] | null;
  readonly timeZone: string;
  /** Formats a `YYYY-MM-DD` day for the chip. */
  readonly formatDay: (day: string) => string;
}

const CHIP =
  'h-control gap-1.5 rounded-full px-3 font-normal lg:h-8 data-[active=true]:border-accent data-[active=true]:bg-accent-soft';

function Chip({
  label,
  value,
  active,
  'data-testid': testId,
}: {
  label: string;
  value: string;
  active: boolean;
  'data-testid': string;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <Button variant="secondary" className={CHIP} data-active={active} data-testid={testId}>
        <span className="text-fg-muted">{label}:</span>
        <span className="max-w-48 truncate">{value}</span>
        <ChevronDown aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
  );
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value].slice(0, MAX_AUDIT_FILTER_VALUES);
}

/** Checkbox items keep the menu open: several values are picked in a row. */
function keepOpen(event: Event) {
  event.preventDefault();
}

/**
 * The filter chips of the viewer (T716, S6-research §4 #6): time range
 * (7 days by default, "Custom…" in a dialog), people (several), action
 * groups by category, object type, base (organization page), source
 * (`via`); exact actions and a batch appear as removable chips. Each menu
 * is a WAI-ARIA menu (arrow keys, type-ahead, Escape).
 */
export function FilterBar({
  filters,
  onChange,
  people,
  bases,
  timeZone,
  formatDay,
}: FilterBarProps) {
  const { t } = useTranslation('audit');
  const actionLabel = useActionLabel();
  const [custom, setCustom] = useState(false);
  const set = (patch: Partial<AuditFilters>) => {
    onChange({ ...filters, ...patch });
  };

  const rangeValue =
    filters.range !== 'custom'
      ? t(`filters.range.${filters.range}`)
      : filters.from !== null && filters.to !== null
        ? t('filters.range.between', { from: formatDay(filters.from), to: formatDay(filters.to) })
        : filters.from !== null
          ? t('filters.range.since', { from: formatDay(filters.from) })
          : t('filters.range.until', { to: formatDay(filters.to ?? '') });

  const peopleValue =
    filters.actors.length === 0
      ? t('filters.people.any')
      : filters.actors.length === 1
        ? (people.find((person) => person.id === filters.actors[0])?.name ??
          filters.actors[0] ??
          '')
        : t('filters.people.count', { count: filters.actors.length });
  const actionValue =
    filters.prefixes.length === 0
      ? t('filters.action.any')
      : filters.prefixes.length === 1
        ? t(`groups.${prefixKey(filters.prefixes[0] ?? '')}`)
        : t('filters.action.count', { count: filters.prefixes.length });
  const viaValue =
    filters.via.length === 0
      ? t('filters.via.any')
      : filters.via.length === 1
        ? t(`viaKinds.${filters.via[0] ?? 'api_token'}`)
        : t('filters.via.count', { count: filters.via.length });
  const baseValue =
    filters.baseId === null
      ? t('filters.base.any')
      : (bases?.find((base) => base.id === filters.baseId)?.name ?? filters.baseId);

  const removable: { key: string; label: string; remove: () => void }[] = [
    ...filters.actions.map((action) => ({
      key: `action:${action}`,
      label: t('filters.action.exact', { action: actionLabel(action) }),
      remove: () => {
        set({ actions: filters.actions.filter((item) => item !== action) });
      },
    })),
    ...(filters.batchId === null
      ? []
      : [
          {
            key: 'batch',
            label: t('filters.batch', { id: filters.batchId }),
            remove: () => {
              set({ batchId: null });
            },
          },
        ]),
  ];
  const narrowed = hasNarrowingFilters(filters) || filters.range !== DEFAULT_FILTERS.range;

  return (
    <div
      role="group"
      aria-label={t('filters.label')}
      className="flex flex-wrap items-center gap-2"
      data-testid="audit-filters"
    >
      <DropdownMenu>
        <Chip
          label={t('filters.range.label')}
          value={rangeValue}
          active={filters.range !== DEFAULT_FILTERS.range}
          data-testid="audit-filter-range"
        />
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={filters.range}
            onValueChange={(value) => {
              if (value === 'custom') {
                setCustom(true);
                return;
              }
              set({ range: value as RangePreset, from: null, to: null });
            }}
          >
            {RANGE_PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset} value={preset}>
                {t(`filters.range.${preset}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <Chip
          label={t('filters.people.label')}
          value={peopleValue}
          active={filters.actors.length > 0}
          data-testid="audit-filter-people"
        />
        <DropdownMenuContent align="start" className="max-w-80">
          <DropdownMenuLabel>{t('filters.people.menu')}</DropdownMenuLabel>
          {people.length === 0 ? (
            <p className="px-2 py-1.5 text-label font-normal text-fg-muted">
              {t('filters.people.none')}
            </p>
          ) : (
            people.map((person) => (
              <DropdownMenuCheckboxItem
                key={person.id}
                checked={filters.actors.includes(person.id)}
                onSelect={keepOpen}
                onCheckedChange={() => {
                  set({ actors: toggle(filters.actors, person.id) });
                }}
                data-testid={`audit-person-${person.id}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{person.name}</span>
                  {person.detail === null || person.detail === undefined ? null : (
                    <span className="truncate text-label font-normal text-fg-muted">
                      {person.detail}
                    </span>
                  )}
                </span>
              </DropdownMenuCheckboxItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <Chip
          label={t('filters.action.label')}
          value={actionValue}
          active={filters.prefixes.length > 0}
          data-testid="audit-filter-action"
        />
        <DropdownMenuContent align="start" className="max-w-80">
          {ACTION_CATEGORIES.map((category, index) => (
            <DropdownMenuGroup key={category.key}>
              {index === 0 ? null : <DropdownMenuSeparator />}
              <DropdownMenuLabel>{t(`categories.${category.key}`)}</DropdownMenuLabel>
              {category.prefixes.map((prefix: AuditActionPrefix) => (
                <DropdownMenuCheckboxItem
                  key={prefix}
                  checked={filters.prefixes.includes(prefix)}
                  onSelect={keepOpen}
                  onCheckedChange={() => {
                    set({ prefixes: toggle(filters.prefixes, prefix) });
                  }}
                  data-testid={`audit-group-${prefixKey(prefix)}`}
                >
                  {t(`groups.${prefixKey(prefix)}`)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <Chip
          label={t('filters.entity.label')}
          value={
            filters.entityType === null
              ? t('filters.entity.any')
              : t(`entityTypes.${filters.entityType}`, { defaultValue: filters.entityType })
          }
          active={filters.entityType !== null}
          data-testid="audit-filter-entity"
        />
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={filters.entityType ?? ''}
            onValueChange={(value) => {
              set({ entityType: value === '' ? null : value });
            }}
          >
            <DropdownMenuRadioItem value="">{t('filters.entity.any')}</DropdownMenuRadioItem>
            {ENTITY_TYPES.map((type) => (
              <DropdownMenuRadioItem key={type} value={type}>
                {t(`entityTypes.${type}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {bases === null ? null : (
        <DropdownMenu>
          <Chip
            label={t('filters.base.label')}
            value={baseValue}
            active={filters.baseId !== null}
            data-testid="audit-filter-base"
          />
          <DropdownMenuContent align="start" className="max-w-80">
            <DropdownMenuRadioGroup
              value={filters.baseId ?? ''}
              onValueChange={(value) => {
                set({ baseId: value === '' ? null : value });
              }}
            >
              <DropdownMenuRadioItem value="">{t('filters.base.any')}</DropdownMenuRadioItem>
              {bases.map((base) => (
                <DropdownMenuRadioItem key={base.id} value={base.id}>
                  <span className="truncate">{base.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <Chip
          label={t('filters.via.label')}
          value={viaValue}
          active={filters.via.length > 0}
          data-testid="audit-filter-via"
        />
        <DropdownMenuContent align="start">
          {AUDIT_VIA_KINDS.map((kind: AuditViaKind) => (
            <DropdownMenuCheckboxItem
              key={kind}
              checked={filters.via.includes(kind)}
              onSelect={keepOpen}
              onCheckedChange={() => {
                set({ via: toggle(filters.via, kind) });
              }}
            >
              {t(`viaKinds.${kind}`)}
            </DropdownMenuCheckboxItem>
          ))}
          {filters.via.length === 0 ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  set({ via: [] });
                }}
              >
                {t('filters.via.any')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {removable.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-control max-w-full items-center gap-1 rounded-full border border-accent bg-accent-soft pr-1 pl-3 text-body lg:h-8"
          data-testid="audit-filter-removable"
        >
          <span className="min-w-0 truncate">{chip.label}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-control rounded-full lg:size-7"
            aria-label={t('filters.remove', { name: chip.label })}
            onClick={chip.remove}
          >
            <X aria-hidden="true" />
          </Button>
        </span>
      ))}

      {narrowed ? (
        <Button
          variant="ghost"
          className="h-control px-2 font-normal text-accent lg:h-8"
          onClick={() => {
            onChange(DEFAULT_FILTERS);
          }}
          data-testid="audit-filters-clear"
        >
          {t('filters.clear')}
        </Button>
      ) : null}

      {/* Mounted while open: each opening starts from the current range. */}
      {custom ? (
        <CustomRangeDialog
          open={custom}
          filters={filters}
          timeZone={timeZone}
          onClose={() => {
            setCustom(false);
          }}
          onApply={(from, to) => {
            setCustom(false);
            set({ range: 'custom', from, to });
          }}
        />
      ) : null}
    </div>
  );
}

function CustomRangeDialog({
  open,
  filters,
  timeZone,
  onClose,
  onApply,
}: {
  open: boolean;
  filters: AuditFilters;
  timeZone: string;
  onClose: () => void;
  onApply: (from: string | null, to: string | null) => void;
}): ReactNode {
  const { t } = useTranslation('audit');
  const today = dayOf(new Date(), timeZone);
  const weekAgo = dayOf(startOfDay(today, timeZone, -6), timeZone);
  const [from, setFrom] = useState(filters.from ?? weekAgo);
  const [to, setTo] = useState(filters.to ?? today);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (from === '' && to === '') {
      setError(t('filters.custom.required'));
      return;
    }
    if (from !== '' && to !== '' && from > to) {
      setError(t('filters.custom.order'));
      return;
    }
    onApply(from === '' ? null : from, to === '' ? null : to);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('filters.custom.title')}
      description={t('filters.custom.description', { timeZone })}
      closeLabel={t('drawer.close')}
    >
      {open ? (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('filters.custom.from')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={from}
                  max={today}
                  data-testid="audit-range-from"
                  onChange={(event) => {
                    setFrom(event.target.value);
                    setError(null);
                  }}
                />
              )}
            </FormField>
            <FormField label={t('filters.custom.to')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={to}
                  max={today}
                  data-testid="audit-range-to"
                  onChange={(event) => {
                    setTo(event.target.value);
                    setError(null);
                  }}
                />
              )}
            </FormField>
          </div>
          {error === null ? null : (
            <p role="alert" className={cn('text-label font-normal text-danger')}>
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('filters.custom.cancel')}
            </Button>
            <Button type="submit" data-testid="audit-range-apply">
              {t('filters.custom.apply')}
            </Button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
