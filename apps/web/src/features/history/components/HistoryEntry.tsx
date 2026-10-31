import { Button, Dialog } from '@cellhive/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bot, Cog, KeyRound, Link2, RotateCcw } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { Avatar } from '../../../grid/display/Avatar';
import { CellValue } from '../../../grid/display/CellValue';
import { initialsOf } from '../../../grid/display/text';
import { canManageAutomations } from '../../../lib/permissions/access';
import { baseQuery } from '../../../lib/query/queries';
import { COLLAPSED_CHANGES, type HistoryItem } from '../group';

import { AttachmentChange } from './AttachmentChange';
import { LinkChange } from './LinkChange';

import type { GridField } from '../../../grid/types';
import type { Formatters } from '../../../lib/i18n/format';
import type { AuditActorDto, AuditViaDto } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

export interface HistoryEntryProps {
  readonly item: HistoryItem;
  /** Fields of the table by id; a change of a field not here (deleted) is not shown. */
  readonly fields: ReadonlyMap<string, GridField>;
  readonly format: Formatters;
  readonly locale: LocaleContext;
  /** Offer "Restore previous value" (the user may edit every changed field). */
  readonly revertable: boolean;
  /** A revert of this item is in flight. */
  readonly reverting: boolean;
  readonly onRevert: (auditId: string) => void;
  /** Cell history: the field is known, its name is left out of each change. */
  readonly singleField?: boolean;
  readonly now: Date;
}

function ActorAvatar({ actor }: { actor: AuditActorDto }) {
  const icon = 'size-3.5';
  let content;
  let colorKey: string | null = null;
  switch (actor.type) {
    case 'automation':
      content = <Bot aria-hidden="true" className={icon} />;
      break;
    case 'api_token':
      content = <KeyRound aria-hidden="true" className={icon} />;
      break;
    case 'share_link':
      content = <Link2 aria-hidden="true" className={icon} />;
      break;
    case 'system':
      content = <Cog aria-hidden="true" className={icon} />;
      break;
    default:
      colorKey = actor.id;
      content = actor.name === null ? '?' : initialsOf(actor.name);
  }
  return (
    <Avatar colorKey={colorKey} size="lg">
      {content}
    </Avatar>
  );
}

/**
 * Who made the change; a deleted user or unnamed source reads as its kind.
 * A share link is named after its view or form (CONTRACTS §11.1, T304:
 * `null` when the view is gone or hidden from the reader).
 */
function useActorName(actor: AuditActorDto): string {
  const { t } = useTranslation('history');
  if (actor.name !== null && actor.name !== '') {
    return actor.type === 'share_link'
      ? t('actor.shareLinkNamed', { name: actor.name })
      : actor.name;
  }
  return t(`actor.${actor.type}`);
}

/** The source line (`via`, CONTRACTS §11.1). */
function useSource(actor: AuditActorDto, via: AuditViaDto | null): string | null {
  const { t } = useTranslation('history');
  if (via?.reverted_from !== undefined) return t('via.revert');
  if (via?.automation_id !== undefined) return t('via.automation');
  if (via?.mcp === true) return t('via.mcp');
  if (via?.api_token_id !== undefined) return t('via.apiToken');
  if (via?.share_link_id !== undefined) return t('via.shareLink');
  if (via?.import_job_id !== undefined) return t('via.import');
  if (actor.type === 'user') return t('via.app');
  if (actor.type === 'api_token') return t('via.apiToken');
  if (actor.type === 'share_link') return t('via.shareLink');
  if (actor.type === 'automation') return t('via.automation');
  return null;
}

/**
 * (T523) "Via automation" links to the run that made the change (the
 * automation's run history, opened on that run) — only for someone who
 * manages automations of the base (the run log is theirs only, CONTRACTS
 * §21). Reads the base already loaded by the route: no request of its own.
 */
function useAutomationLink(via: AuditViaDto | null): string | null {
  const { baseId } = useParams();
  const queryClient = useQueryClient();
  if (via?.automation_id === undefined || baseId === undefined) return null;
  const base = queryClient.getQueryData(baseQuery(baseId).queryKey);
  if (base === undefined || !canManageAutomations(base.access)) return null;
  const path = `/b/${baseId}/automations/${via.automation_id}`;
  return via.run_id === undefined ? path : `${path}/runs?run=${encodeURIComponent(via.run_id)}`;
}

function useVerb(item: HistoryItem, fields: ReadonlyMap<string, GridField>): string {
  const { t } = useTranslation('history');
  const { head } = item;
  switch (head.action) {
    case 'record.created':
      return t('verb.created');
    case 'record.deleted':
      return t('verb.deleted');
    case 'record.restored':
      return t('verb.restored');
    default: {
      if (head.via?.reverted_from !== undefined) return t('verb.reverted');
      const shown = item.changes.filter((change) => fields.has(change.fieldId));
      const only = shown.length === 1 ? shown[0] : undefined;
      if (only !== undefined) {
        return t('verb.changedField', { field: fields.get(only.fieldId)?.field.name ?? '' });
      }
      return t('verb.changedFields', { count: shown.length });
    }
  }
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

/**
 * One item of the history timeline (FRONTEND §10.3; design "Chi tiết record
 * và lịch sử"): avatar, who and what, relative time with the absolute time
 * as tooltip, the source line, the changes `field: before → after` (the
 * old value struck through) and "Restore previous value".
 */
export function HistoryEntry({
  item,
  fields,
  format,
  locale,
  revertable,
  reverting,
  onRevert,
  singleField = false,
  now,
}: HistoryEntryProps) {
  const { t } = useTranslation('history');
  const { head } = item;
  const name = useActorName(head.actor);
  const source = useSource(head.actor, head.via);
  const automationLink = useAutomationLink(head.via);
  const verb = useVerb(item, fields);
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const changesId = useId();

  const order = [...fields.keys()];
  const changes = item.changes
    .filter((change) => fields.has(change.fieldId))
    .sort((a, b) => order.indexOf(a.fieldId) - order.indexOf(b.fieldId));
  const collapsible = changes.length > COLLAPSED_CHANGES;
  const shown = collapsible && !expanded ? changes.slice(0, COLLAPSED_CHANGES) : changes;
  const absolute = format.dateTime(head.created_at);
  const empty = <span className="text-fg-subtle italic">{t('empty')}</span>;

  return (
    <li className="flex gap-3 py-3">
      <ActorAvatar actor={head.actor} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body">
          <span className="font-medium">{name}</span> {verb}
          <span className="text-fg-muted">
            {' · '}
            <time dateTime={head.created_at} title={absolute}>
              {/* A server clock slightly ahead must not read "in 1 second". */}
              {format.relative(new Date(Math.min(Date.parse(head.created_at), now.getTime())), now)}
            </time>
          </span>
        </p>
        {source === null && head.batch === null ? null : (
          <p className="text-label font-normal text-fg-muted">
            {automationLink === null || source === null ? (
              source
            ) : (
              <Link
                to={automationLink}
                className="text-accent underline-offset-2 hover:underline"
                data-testid="history-automation-link"
              >
                {source}
              </Link>
            )}
            {source !== null && head.batch !== null ? ' · ' : null}
            {head.batch === null ? null : t('batch', { count: head.batch.size })}
          </p>
        )}
        {changes.length === 0 ? null : (
          <ul id={changesId} className="mt-1 flex flex-col gap-1.5" aria-label={t('changes')}>
            {shown.map((change) => {
              const field = fields.get(change.fieldId);
              if (field === undefined) return null;
              const created = head.action === 'record.created';
              return (
                <li
                  key={change.fieldId}
                  className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-body sm:grid-cols-[minmax(6rem,10rem)_1fr]"
                >
                  {singleField ? null : (
                    <span className="truncate text-label text-fg-muted">{field.field.name}</span>
                  )}
                  {field.config?.type === 'attachment' ? (
                    // Files added / removed (T418), not two lists of names.
                    <AttachmentChange from={change.from} to={change.to} />
                  ) : field.field.type === 'link' ? (
                    // Records linked / unlinked (T465), titles as the viewer reads them now.
                    <LinkChange from={change.from} to={change.to} />
                  ) : (
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {created || isBlank(change.from) ? null : (
                        <>
                          <span className="min-w-0 text-fg-muted line-through">
                            <span className="sr-only">{t('before')}</span>
                            <CellValue
                              field={field}
                              value={change.from}
                              locale={locale}
                              empty={empty}
                            />
                          </span>
                          <ArrowRight
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-fg-subtle"
                          />
                        </>
                      )}
                      <span className="min-w-0">
                        <span className="sr-only">{t('after')}</span>
                        <CellValue field={field} value={change.to} locale={locale} empty={empty} />
                      </span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {collapsible ? (
            <Button
              variant="link"
              size="sm"
              aria-expanded={expanded}
              aria-controls={changesId}
              onClick={() => {
                setExpanded((open) => !open);
              }}
            >
              {expanded ? t('showLess') : t('showAll', { count: changes.length })}
            </Button>
          ) : null}
          {revertable ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={reverting}
              onClick={() => {
                setConfirming(true);
              }}
            >
              <RotateCcw aria-hidden="true" />
              {t('revert.action', { count: changes.length })}
            </Button>
          ) : null}
        </div>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('revert.confirmTitle', { count: changes.length })}
        description={t('revert.confirmDescription', { count: changes.length })}
        closeLabel={t('revert.cancel')}
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setConfirming(false);
            }}
          >
            {t('revert.cancel')}
          </Button>
          <Button
            onClick={() => {
              setConfirming(false);
              onRevert(head.id);
            }}
          >
            {t('revert.confirm')}
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
