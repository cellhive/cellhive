import { Button, cn, Dialog } from '@cellhive/ui';
import { Filter, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { diffRows, isRedacted } from '../model';

import { ActorAvatar, EntityText, ViaLabels } from './labels';

import type { AuditRow } from './AuditList';
import type { AuditRefsDto } from '@cellhive/contracts';
import type { ReactNode } from 'react';

export interface AuditDrawerProps {
  readonly row: AuditRow | null;
  readonly refs: AuditRefsDto;
  readonly onClose: () => void;
  /** "Show the same batch": filter the list by `batch_id`. */
  readonly onSameBatch: (batchId: string) => void;
  /** "Show only this action": filter the list by the exact action. */
  readonly onOnlyAction: (action: string) => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label font-semibold text-fg-muted">{title}</h3>
      {children}
    </section>
  );
}

/** A stored value as text in a monospace block (never HTML). */
function Value({ text }: { text: string | null }) {
  const { t } = useTranslation('audit');
  if (text === null) return <span className="text-fg-subtle italic">{t('drawer.noValue')}</span>;
  return <span className="font-mono text-label whitespace-pre-wrap break-all text-fg">{text}</span>;
}

/**
 * Details of one entry (T716) in a drawer (`Dialog layout="drawer"`, a
 * bottom sheet below 768 px): who and through what, the object, the
 * before/after values by the **current** field names (a field removed for
 * good: id + "deleted"), IP, user agent, request id and batch id with
 * "Show the same batch". Escape closes it and the focus returns to the
 * entry that opened it (the page does that).
 */
export function AuditDrawer({ row, refs, onClose, onSameBatch, onOnlyAction }: AuditDrawerProps) {
  const { t } = useTranslation('audit');
  const entry = row?.entry ?? null;
  const rows = entry === null ? [] : diffRows(entry, refs);
  const redacted = entry !== null && isRedacted(entry);
  const record = entry?.entity_type === 'record';
  const details: { key: string; label: string; value: string | null; mono: boolean }[] =
    entry === null
      ? []
      : [
          { key: 'ip', label: t('drawer.ip'), value: entry.ip, mono: true },
          { key: 'ua', label: t('drawer.userAgent'), value: entry.user_agent, mono: false },
          { key: 'request', label: t('drawer.requestId'), value: entry.request_id, mono: true },
          { key: 'batch', label: t('drawer.batchId'), value: entry.batch_id, mono: true },
          { key: 'id', label: t('drawer.entryId'), value: entry.id, mono: true },
        ];

  return (
    <Dialog
      open={row !== null}
      layout="drawer"
      className="md:overflow-y-auto"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={row?.action ?? ''}
      description={
        row === null ? undefined : <time dateTime={row.entry.created_at}>{row.time}</time>
      }
      closeLabel={t('drawer.close')}
    >
      {row === null || entry === null ? null : (
        <div className="flex flex-col gap-5" data-testid="audit-drawer">
          <Section title={t('drawer.who')}>
            <span className="flex min-w-0 items-start gap-2">
              <ActorAvatar actor={row.actor} className="mt-px" />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="break-words text-fg" data-testid="audit-drawer-actor">
                  {row.actorText}
                </span>
                <ViaLabels via={row.via} />
              </span>
            </span>
          </Section>

          <Section title={t('drawer.object')}>
            <EntityText entity={row.entity} />
          </Section>

          <Section title={t('drawer.changes')}>
            {redacted ? (
              <p className="text-body text-fg-muted">{t('drawer.redacted')}</p>
            ) : rows.length === 0 ? (
              <p className="text-body text-fg-muted">{t('drawer.noChanges')}</p>
            ) : (
              <>
                <dl className="flex flex-col divide-y divide-line rounded-md border border-line">
                  {rows.map((item) => (
                    <div
                      key={item.key}
                      className="flex flex-col gap-1.5 p-2.5"
                      data-testid="audit-diff-row"
                      data-key={item.key}
                    >
                      <dt className="flex flex-wrap items-baseline gap-x-2 text-body font-medium text-fg">
                        {item.label.name ?? (
                          <span>
                            <span className="font-mono text-label break-all">{item.label.id}</span>{' '}
                            <span className="font-normal text-fg-muted">
                              ({t('object.deleted')})
                            </span>
                          </span>
                        )}
                        {item.label.name !== null && item.label.deleted ? (
                          <span className="text-label font-normal text-fg-muted">
                            ({t('object.inTrash')})
                          </span>
                        ) : null}
                        {item.changed && entry.before !== null && entry.after !== null ? (
                          <span className="text-label font-normal text-accent">
                            {t('drawer.changed')}
                          </span>
                        ) : null}
                      </dt>
                      <dd className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                        <span className="text-label font-normal text-fg-muted">
                          {t('drawer.before')}
                        </span>
                        <span
                          data-testid="audit-diff-before"
                          className={cn(item.changed && 'line-through decoration-danger/60')}
                        >
                          <Value text={item.before} />
                        </span>
                        <span className="text-label font-normal text-fg-muted">
                          {t('drawer.after')}
                        </span>
                        <span data-testid="audit-diff-after">
                          <Value text={item.after} />
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
                {record ? (
                  <p className="text-label font-normal text-fg-muted">{t('drawer.storedNote')}</p>
                ) : null}
              </>
            )}
          </Section>

          <Section title={t('drawer.details')}>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body">
              {details.map((item) => (
                <div key={item.key} className="contents">
                  <dt className="text-label font-normal text-fg-muted">{item.label}</dt>
                  <dd
                    className={cn(
                      'min-w-0 break-all text-fg',
                      item.mono && item.value !== null && 'font-mono text-label',
                    )}
                    data-testid={`audit-detail-${item.key}`}
                  >
                    {item.value ?? (
                      <span className="text-fg-subtle">{t('drawer.notRecorded')}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>

          <div className="flex flex-wrap gap-2">
            {entry.batch_id === null ? null : (
              <Button
                variant="secondary"
                onClick={() => {
                  if (entry.batch_id !== null) onSameBatch(entry.batch_id);
                }}
                data-testid="audit-same-batch"
              >
                <Layers aria-hidden="true" />
                {t('drawer.sameBatch')}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                onOnlyAction(entry.action);
              }}
              data-testid="audit-only-action"
            >
              <Filter aria-hidden="true" />
              {t('drawer.onlyAction')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
