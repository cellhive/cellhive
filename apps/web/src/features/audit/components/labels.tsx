import { cn } from '@cellhive/ui';
import { Bot, Cog, KeyRound, Link2, Webhook } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { actionParts, prefixKey, type ActorLabel, type EntityLabel, type ViaLabel } from '../model';

/**
 * Text of the names an entry carries (T716). Names and values are always
 * rendered as React text — never as HTML.
 */

/** "Records · updated" for `record.updated`; an action of no known group as it is. */
export function useActionLabel(): (action: string) => string {
  const { t } = useTranslation('audit');
  return useCallback(
    (action: string) => {
      const parts = actionParts(action);
      if (parts === null) return action;
      const group = t(`groups.${prefixKey(parts.prefix)}`, { defaultValue: parts.prefix });
      const verb = t(`verbs.${parts.verb}`, { defaultValue: parts.verb });
      return `${group} · ${verb}`;
    },
    [t],
  );
}

export function useActorText(): (actor: ActorLabel) => string {
  const { t } = useTranslation('audit');
  return useCallback(
    (actor: ActorLabel) => {
      switch (actor.kind) {
        case 'user':
          return actor.name ?? `${actor.id ?? ''} (${t('actor.deleted')})`;
        case 'automation':
          return actor.name === null
            ? t('actor.automation')
            : t('actor.automationNamed', { name: actor.name });
        case 'share_link':
          return actor.name === null
            ? t('actor.shareLink')
            : t('actor.shareLinkNamed', { name: actor.name });
        case 'system':
          return t('actor.system');
        case 'api_token':
          return t('actor.apiToken');
        case 'webhook':
          return t('actor.webhook');
      }
    },
    [t],
  );
}

export function useViaText(): (via: ViaLabel) => string {
  const { t } = useTranslation('audit');
  return useCallback(
    (via: ViaLabel) =>
      via.kind === 'api_token'
        ? via.name === null
          ? t('via.apiToken')
          : t('via.apiTokenNamed', { name: via.name })
        : t(`via.${via.kind}`),
    [t],
  );
}

/** Text of an entry's object, for accessible names and cards. */
export function useEntityText(): (entity: EntityLabel) => string {
  const { t } = useTranslation('audit');
  return useCallback(
    (entity: EntityLabel) => {
      if (entity.id === null) return t('object.none');
      const type = t(`entityTypes.${entity.type}`, { defaultValue: entity.type });
      const main =
        entity.type === 'record'
          ? t('object.record', { id: entity.id })
          : entity.name !== null
            ? `${type} ${entity.name}${entity.deleted ? ` (${t('object.inTrash')})` : ''}`
            : `${type} ${entity.id}${entity.deleted ? ` (${t('object.deleted')})` : ''}`;
      const table = entity.table;
      if (table === null) return main;
      const tableName =
        table.name === null ? `${table.id ?? ''} (${t('object.deleted')})` : table.name;
      return `${main} ${t('object.inTable', { table: tableName })}`;
    },
    [t],
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = words[0]?.[0] ?? '?';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** A small round avatar: initials of a person, an icon for the others (decorative). */
export function ActorAvatar({ actor, className }: { actor: ActorLabel; className?: string }) {
  const Icon =
    actor.kind === 'automation'
      ? Bot
      : actor.kind === 'share_link'
        ? Link2
        : actor.kind === 'api_token'
          ? KeyRound
          : actor.kind === 'webhook'
            ? Webhook
            : actor.kind === 'system'
              ? Cog
              : null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-fg',
        actor.kind === 'user' && actor.name === null && 'bg-surface-sunken text-fg-muted',
        className,
      )}
    >
      {Icon === null ? (
        initials(actor.kind === 'user' ? (actor.name ?? '?') : '?')
      ) : (
        <Icon className="size-3.5" />
      )}
    </span>
  );
}

/** "via API token CRM sync", "via automation"… as small labels. */
export function ViaLabels({ via, className }: { via: readonly ViaLabel[]; className?: string }) {
  const text = useViaText();
  if (via.length === 0) return null;
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {via.map((item) => (
        <span
          // One label per kind and entry.
          key={item.kind}
          data-testid="audit-via"
          className="inline-flex max-w-full items-center gap-1 rounded-sm bg-surface-sunken px-1.5 text-label font-normal break-all text-fg-muted"
        >
          {item.kind === 'api_token' ? (
            <KeyRound aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          {text(item)}
        </span>
      ))}
    </span>
  );
}

/** The object of an entry: its name (or id + "deleted") and its table. */
export function EntityText({ entity }: { entity: EntityLabel }) {
  const { t } = useTranslation('audit');
  if (entity.id === null) return <span className="text-fg-muted">{t('object.none')}</span>;
  const type = t(`entityTypes.${entity.type}`, { defaultValue: entity.type });
  const table = entity.table;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="min-w-0 break-words">
        <span className="text-fg-muted">{type} </span>
        {entity.type !== 'record' && entity.name !== null ? (
          <span className="text-fg">{entity.name}</span>
        ) : (
          <span className="font-mono text-label break-all text-fg">{entity.id}</span>
        )}
        {entity.deleted ? (
          <span className="text-fg-muted">
            {' '}
            ({entity.name === null ? t('object.deleted') : t('object.inTrash')})
          </span>
        ) : null}
      </span>
      {table === null ? null : (
        <span className="text-label font-normal break-words text-fg-muted">
          {t('object.inTable', {
            table:
              table.name === null
                ? `${table.id ?? ''} (${t('object.deleted')})`
                : `${table.name}${table.deleted ? ` (${t('object.inTrash')})` : ''}`,
          })}
        </span>
      )}
    </span>
  );
}
