import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Switch,
} from '@cellhive/ui';
import { CirclePause, Copy, History, Lock, MoreHorizontal, Trash2, UserCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Avatar } from '../../../../grid/display/Avatar';
import { initialsOf } from '../../../../grid/display/text';
import { useFormatters } from '../../../../lib/i18n/format';
import { automationRunsPath } from '../../runs/components/AutomationTabs';
import { TRIGGER_ICONS } from '../../trigger-icons';
import { summarizeTrigger, type SchemaNames } from '../model/summary';

import type { AutomationDto, AutomationListItem } from '@cellhive/contracts';

export interface AutomationRowsProps {
  readonly items: readonly AutomationListItem[];
  readonly names: SchemaNames;
  readonly meId: string | null;
  /** Id of the automation with a write in flight: its controls wait. */
  readonly pendingId: string | null;
  readonly onToggle: (automation: AutomationDto, on: boolean) => void;
  readonly onTakeOver: (automation: AutomationDto) => void;
  readonly onDelete: (automation: AutomationDto) => void;
  /** (T556) "Duplicate" of the row menu (≥ 768 px; phones have no menu). */
  readonly onDuplicate: (automation: AutomationDto) => void;
}

/** Element id of a row's switch (the realtime toast's "View" focuses it). */
export function switchIdOf(automation: Pick<AutomationDto, 'id'>, layout: 'table' | 'card') {
  return `automation-switch-${layout}-${automation.id}`;
}

function RunAs({ automation }: { readonly automation: AutomationDto }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar colorKey={automation.run_as.id} size="md">
        {initialsOf(automation.run_as.name)}
      </Avatar>
      <span className="truncate">{automation.run_as.name}</span>
    </span>
  );
}

/** Latest run (T518): its status and how long ago it was created; "Never run" without one. */
function LastRun({ automation }: { readonly automation: AutomationListItem }) {
  const { t } = useTranslation('automation');
  const format = useFormatters();
  const run = automation.last_run;
  if (run === null) return <span className="text-fg-muted">{t('row.neverRun')}</span>;
  return (
    <span className="flex min-w-0 flex-col">
      <span
        className={cn(
          'truncate',
          run.status === 'failed' ? 'text-danger' : run.status === 'succeeded' ? 'text-fg' : '',
        )}
      >
        {t(`runStatus.${run.status}`)}
      </span>
      <time
        className="truncate text-fg-muted"
        dateTime={run.created_at}
        title={format.dateTime(run.created_at)}
      >
        {format.relative(run.created_at)}
      </time>
    </span>
  );
}

/**
 * Runs `failed` in the last 24 hours (T518), red when there are any; then a
 * link to those runs (T523).
 */
function Errors24h({ automation }: { readonly automation: AutomationListItem }) {
  const { t } = useTranslation('automation');
  const format = useFormatters();
  const count = automation.errors_24h;
  if (count === 0) return <span className="text-fg-muted">{format.number(count)}</span>;
  return (
    <Link
      to={automationRunsPath(automation.base_id, automation.id, { status: 'failed', range: '24h' })}
      aria-label={t('row.errorsLink', { count })}
      className="font-medium text-danger underline-offset-2 hover:underline"
      data-testid={`automation-errors-${automation.id}`}
    >
      {format.number(count)}
    </Link>
  );
}

/**
 * Why the system turned it off and what to do (board "S5 · Automation
 * list"): red for the circuit breaker ("Turn back on"), amber for a `run_as`
 * who lost access ("Take over"). `compact`: the one-line form of phones.
 */
function DisabledNote({
  automation,
  compact,
  pending,
  onEnable,
  onTakeOver,
}: {
  readonly automation: AutomationDto;
  readonly compact: boolean;
  readonly pending: boolean;
  readonly onEnable: () => void;
  readonly onTakeOver: () => void;
}) {
  const { t } = useTranslation('automation');
  const reason = automation.disabled_reason;
  if (reason === null) return null;
  const breaker = reason === 'circuit_breaker';
  const Icon = breaker ? CirclePause : Lock;
  return (
    <div
      role="note"
      data-testid={`disabled-note-${automation.id}`}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-label font-normal text-fg',
        breaker ? 'border-danger/40 bg-danger/5' : 'border-warning/50 bg-option-3',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn('mt-0.5 size-4 shrink-0', breaker ? 'text-danger' : 'text-warning')}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="font-semibold">
          {compact
            ? t(`disabled.${reason}.short`)
            : t(`disabled.${reason}.title`, { name: automation.run_as.name })}
        </strong>
        {compact ? null : <span className="text-fg-muted">{t(`disabled.${reason}.detail`)}</span>}
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            className={cn('max-lg:h-control', compact && 'flex-1')}
            onClick={breaker ? onEnable : onTakeOver}
          >
            {breaker ? null : <UserCheck aria-hidden="true" />}
            {t(`disabled.${reason}.action`)}
          </Button>
          {/* T523: the failed runs behind the breaker; the builder for a lost `run_as`. */}
          <Button
            asChild
            size="sm"
            variant="ghost"
            className={cn('max-lg:h-control', compact && 'flex-1')}
          >
            <Link
              to={
                breaker
                  ? automationRunsPath(automation.base_id, automation.id, { status: 'failed' })
                  : `/b/${automation.base_id}/automations/${automation.id}`
              }
              data-testid={`disabled-note-link-${automation.id}`}
            >
              {breaker ? <History aria-hidden="true" /> : null}
              {t(breaker ? 'disabled.viewRuns' : 'disabled.viewDetails')}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function useSummary(automation: AutomationDto, names: SchemaNames) {
  const { t, i18n } = useTranslation('automation');
  return summarizeTrigger(automation, names, t, i18n.language);
}

function TriggerLine({
  automation,
  names,
}: {
  readonly automation: AutomationDto;
  readonly names: SchemaNames;
}) {
  const summary = useSummary(automation, names);
  const Icon = TRIGGER_ICONS[automation.definition.trigger.type];
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-label font-normal text-fg-muted">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0">{summary.label}</span>
      {summary.detail === null ? null : (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate" title={summary.detail}>
            {summary.detail}
          </span>
        </>
      )}
    </span>
  );
}

function RowMenu({
  automation,
  meId,
  disabled,
  onTakeOver,
  onDelete,
  onDuplicate,
}: {
  readonly automation: AutomationDto;
  readonly meId: string | null;
  readonly disabled: boolean;
  readonly onTakeOver: () => void;
  readonly onDelete: () => void;
  readonly onDuplicate: () => void;
}) {
  const { t } = useTranslation('automation');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('row.menu', { name: automation.name })}
        disabled={disabled}
        data-testid={`automation-menu-${automation.id}`}
        className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 max-lg:size-control"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to={automationRunsPath(automation.base_id, automation.id)}>
            <History aria-hidden="true" />
            {t('row.runs')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onDuplicate}
          data-testid={`automation-duplicate-${automation.id}`}
        >
          <Copy aria-hidden="true" />
          {t('row.duplicate')}
        </DropdownMenuItem>
        {automation.run_as.id === meId ? null : (
          <DropdownMenuItem onSelect={onTakeOver}>
            <UserCheck aria-hidden="true" />
            {t('row.takeOver')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="text-danger [&_svg]:text-danger" onSelect={onDelete}>
          <Trash2 aria-hidden="true" />
          {t('row.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TH = 'h-[34px] px-2.5 text-left text-label font-medium whitespace-nowrap text-fg-muted';

/**
 * The list from 768 px (board "S5 · Automation list"): switch, name and
 * trigger, `run_as`, last run, errors in 24 h (run counts of T518), menu;
 * under a row the system turned off, why and what to do.
 */
export function AutomationTable({
  items,
  names,
  meId,
  pendingId,
  caption,
  onToggle,
  onTakeOver,
  onDelete,
  onDuplicate,
}: AutomationRowsProps & { readonly caption: string }) {
  const { t } = useTranslation('automation');
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <table
        className="w-full table-fixed border-collapse text-body"
        data-testid="automation-table"
      >
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className="w-14" />
          <col />
          <col className="w-[190px] max-lg:w-[150px]" />
          <col className="w-[150px] max-lg:w-[96px]" />
          <col className="w-[76px]" />
          <col className="w-12 max-lg:w-14" />
        </colgroup>
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className={cn(TH, 'pl-4')}>
              {t('column.enabled')}
            </th>
            <th scope="col" className={cn(TH, 'pl-1')}>
              {t('column.automation')}
            </th>
            <th scope="col" className={TH}>
              {t('column.runAs')}
            </th>
            <th scope="col" className={TH}>
              {t('column.lastRun')}
            </th>
            <th scope="col" className={cn(TH, 'text-right')}>
              {t('column.errors')}
            </th>
            <th scope="col" className={TH}>
              <span className="sr-only">{t('column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((automation) => {
            const pending = pendingId === automation.id;
            return [
              <tr
                key={automation.id}
                data-testid={`automation-row-${automation.id}`}
                aria-busy={pending}
                className="border-t border-line"
              >
                <td className="py-3 pl-4 align-middle">
                  <Switch
                    id={switchIdOf(automation, 'table')}
                    checked={automation.enabled}
                    disabled={pending}
                    aria-label={t('row.switch', { name: automation.name })}
                    onChange={(event) => {
                      onToggle(automation, event.target.checked);
                    }}
                  />
                </td>
                <td className="py-3 pr-3 pl-1 align-middle">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    {/* T521: the name opens the builder. */}
                    <Link
                      to={`/b/${automation.base_id}/automations/${automation.id}`}
                      className={cn(
                        'truncate font-medium hover:underline',
                        automation.enabled ? 'text-fg' : 'text-fg-muted',
                      )}
                      data-testid={`automation-link-${automation.id}`}
                    >
                      {automation.name}
                    </Link>
                    <TriggerLine automation={automation} names={names} />
                  </span>
                </td>
                <td className="px-2.5 align-middle">
                  <RunAs automation={automation} />
                </td>
                <td className="px-2.5 align-middle text-label">
                  <LastRun automation={automation} />
                </td>
                <td className="px-2.5 text-right align-middle tabular-nums">
                  <Errors24h automation={automation} />
                </td>
                <td className="text-center align-middle">
                  <RowMenu
                    automation={automation}
                    meId={meId}
                    disabled={pending}
                    onTakeOver={() => {
                      onTakeOver(automation);
                    }}
                    onDelete={() => {
                      onDelete(automation);
                    }}
                    onDuplicate={() => {
                      onDuplicate(automation);
                    }}
                  />
                </td>
              </tr>,
              automation.disabled_reason === null ? null : (
                <tr key={`${automation.id}-note`}>
                  <td />
                  <td colSpan={5} className="pr-4 pb-3">
                    <DisabledNote
                      automation={automation}
                      compact={false}
                      pending={pending}
                      onEnable={() => {
                        onToggle(automation, true);
                      }}
                      onTakeOver={() => {
                        onTakeOver(automation);
                      }}
                    />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Phones (board "S5 · Automation list - 375 px"): one card per automation —
 * name, trigger, switch (44 px target), `run_as`; the reason it was turned
 * off with a full-width button. No menu: editing waits for a wide screen.
 */
export function AutomationCards({
  items,
  names,
  pendingId,
  onToggle,
  onTakeOver,
}: AutomationRowsProps) {
  const { t } = useTranslation('automation');
  return (
    <ul
      className="-mx-4 flex flex-col border-y border-line bg-surface"
      data-testid="automation-cards"
    >
      {items.map((automation) => {
        const pending = pendingId === automation.id;
        return (
          <li
            key={automation.id}
            data-testid={`automation-card-${automation.id}`}
            aria-busy={pending}
            className="flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0"
          >
            <div className="flex items-start gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-heading font-medium break-words">{automation.name}</span>
                <TriggerLine automation={automation} names={names} />
              </span>
              <span className="flex h-11 items-center">
                <Switch
                  id={switchIdOf(automation, 'card')}
                  checked={automation.enabled}
                  disabled={pending}
                  aria-label={t('row.switch', { name: automation.name })}
                  onChange={(event) => {
                    onToggle(automation, event.target.checked);
                  }}
                />
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-2 text-label font-normal text-fg-muted">
              <RunAs automation={automation} />
            </div>
            <DisabledNote
              automation={automation}
              compact
              pending={pending}
              onEnable={() => {
                onToggle(automation, true);
              }}
              onTakeOver={() => {
                onTakeOver(automation);
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}
