import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFormatters } from '../../../../lib/i18n/format';
import { fieldsQuery } from '../../../../lib/query/queries';
import { plainValue, stepOutputView, warningsOf, type StepOutputView } from '../model/output';
import { smtpReplyText, type RecipientRejection } from '../model/rejections';

import type { AutomationAction, AutomationRunStepDto } from '@cellhive/contracts';
import type { ReactNode } from 'react';

/** "Hidden (no permission)": a value the server redacted for the viewer (CONTRACTS §21). */
export function HiddenValue() {
  const { t } = useTranslation('automationRuns');
  return (
    <em className="text-fg-muted not-italic" data-testid="redacted-value">
      {t('output.hidden')}
    </em>
  );
}

/**
 * Refused recipients of a `send_email` step (T556, QA S5 L1; board "S5 ·
 * Run history"): "c***@example.com · mailbox does not exist" with the
 * server's reply code beside it. Addresses are masked by the server and
 * never rebuilt; the reason is worded from the codes (the server's text is
 * not kept). A `total` above the list's length (the server keeps 50) adds
 * "and N more".
 */
export function RejectedRecipients({
  items,
  total,
  'data-testid': testId,
}: {
  readonly items: readonly RecipientRejection[];
  readonly total?: number;
  readonly 'data-testid'?: string;
}) {
  const { t } = useTranslation('automationRuns');
  const more = Math.max(0, (total ?? items.length) - items.length);
  return (
    <ul className="flex flex-col gap-0.5" data-testid={testId}>
      {items.map((item, index) => {
        const code = smtpReplyText(item.smtp);
        return (
          <li
            key={`${item.masked ?? ''}-${String(index)}`}
            className="flex flex-wrap items-baseline gap-x-2"
            data-testid="rejected-recipient"
          >
            <span className="min-w-0 break-all">
              {item.masked ?? <HiddenValue />}
              {' · '}
              {t(`rejectionReason.${item.reason}`)}
            </span>
            {code === null ? null : (
              <span className="font-mono text-[12px] text-fg-muted">{code}</span>
            )}
          </li>
        );
      })}
      {more === 0 ? null : (
        <li className="text-fg-muted">{t('detail.rejectedMore', { count: more })}</li>
      )}
    </ul>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Grid({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-label font-normal sm:grid-cols-[minmax(7rem,9rem)_1fr]">
      {children}
    </dl>
  );
}

/** The table an action works on (to name fields and link records). */
function tableOf(action: AutomationAction | null): string | null {
  if (action === null) return null;
  const config = action.config as { table_id?: unknown };
  return typeof config.table_id === 'string' ? config.table_id : null;
}

function RecordId({
  baseId,
  tableId,
  recordId,
}: {
  readonly baseId: string;
  readonly tableId: string | null;
  readonly recordId: string;
}) {
  const text = <span className="font-mono text-[12px]">{recordId}</span>;
  if (tableId === null) return text;
  return (
    <Link
      to={`/b/${baseId}/t/${tableId}?record=${encodeURIComponent(recordId)}`}
      className="text-accent underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  );
}

function OutputBody({
  view,
  baseId,
  tableId,
  userName,
}: {
  readonly view: StepOutputView;
  readonly baseId: string;
  readonly tableId: string | null;
  readonly userName: (userId: string) => string | null;
}) {
  const { t } = useTranslation('automationRuns');
  const format = useFormatters();
  const fields = useQuery({
    ...fieldsQuery(tableId ?? ''),
    enabled: view.kind === 'find' && tableId !== null,
  });
  const fieldName = (fieldId: string) =>
    fields.data?.items.find((field) => field.id === fieldId)?.name ?? fieldId;
  const n = (value: number | null) => (value === null ? '—' : format.number(value));
  const time = (value: string | null) =>
    value === null || Number.isNaN(Date.parse(value)) ? null : format.dateTime(value);

  switch (view.kind) {
    case 'record':
      return (
        <Grid>
          <Row label={t('output.record')}>
            {view.recordId === null ? (
              <HiddenValue />
            ) : (
              <RecordId baseId={baseId} tableId={tableId} recordId={view.recordId} />
            )}
          </Row>
        </Grid>
      );
    case 'if':
      return (
        <Grid>
          <Row label={t('output.branch')}>
            {view.branch === null
              ? '—'
              : t(`output.branchName.${view.branch}`, { defaultValue: view.branch })}
          </Row>
        </Grid>
      );
    case 'find':
      return (
        <div className="flex flex-col gap-2">
          <Grid>
            <Row label={t('output.found')}>
              {view.truncated
                ? t('output.foundTruncated', { count: view.count ?? 0, shown: view.records.length })
                : t('output.foundCount', { count: view.count ?? view.records.length })}
            </Row>
          </Grid>
          {view.records.length === 0 ? null : (
            <ul className="flex flex-col gap-1.5" aria-label={t('output.records')}>
              {view.records.map((record, index) => (
                <li
                  key={`${record.id}-${String(index)}`}
                  className="rounded-md border border-line bg-surface-sunken px-2.5 py-1.5 text-label font-normal"
                >
                  {record.hidden ? (
                    <span className="flex flex-wrap items-center gap-x-2">
                      <span className="text-fg-muted">
                        {t('output.recordN', { number: index + 1 })}
                      </span>
                      <HiddenValue />
                    </span>
                  ) : (
                    <span className="flex flex-col gap-0.5">
                      <RecordId baseId={baseId} tableId={tableId} recordId={record.id} />
                      {record.values.map((item) => (
                        <span key={item.fieldId} className="min-w-0 break-words">
                          <span className="text-fg-muted">{fieldName(item.fieldId)}: </span>
                          {item.hidden ? (
                            <HiddenValue />
                          ) : (
                            plainValue(item.value, t('output.yes'), t('output.no')) || (
                              <span className="text-fg-subtle">{t('output.empty')}</span>
                            )
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'updateRecords':
      return (
        <Grid>
          <Row label={t('output.matched')}>{n(view.matched)}</Row>
          <Row label={t('output.updated')}>{n(view.updated)}</Row>
          {view.skippedNotEditable === null || view.skippedNotEditable === 0 ? null : (
            <Row label={t('output.skippedNotEditable')}>{n(view.skippedNotEditable)}</Row>
          )}
          <Row label={t('output.batches')}>{n(view.batches)}</Row>
        </Grid>
      );
    case 'delay':
      return (
        <Grid>
          <Row label={t('output.until')}>{time(view.until) ?? <HiddenValue />}</Row>
          {view.resumedAt === null ? null : (
            <Row label={t('output.resumedAt')}>{time(view.resumedAt)}</Row>
          )}
          {view.recheck === null ? null : (
            <Row label={t('output.recheck')}>
              {t(`output.recheckResult.${view.recheck}`, { defaultValue: view.recheck })}
            </Row>
          )}
        </Grid>
      );
    case 'email':
      return (
        <Grid>
          {view.mode === null ? null : (
            <Row label={t('output.mode')}>
              {t(`output.modeName.${view.mode}`, { defaultValue: view.mode })}
            </Row>
          )}
          <Row label={t('output.accepted')}>
            {view.accepted.length === 0 ? '—' : view.accepted.join(', ')}
          </Row>
          {view.rejected.length === 0 ? null : (
            <Row label={t('output.rejected')}>
              <RejectedRecipients items={view.rejected} data-testid="output-rejected" />
            </Row>
          )}
          {view.attachmentCount === null || view.attachmentCount === 0 ? null : (
            <Row label={t('output.attachments')}>
              {t('output.attachmentSize', {
                count: view.attachmentCount,
                size: format.number(Math.round((view.attachmentBytes ?? 0) / 1024)),
              })}
            </Row>
          )}
          {view.inlineImageCount === null || view.inlineImageCount === 0 ? null : (
            <Row label={t('output.inlineImages')}>
              {t('output.inlineImageSize', {
                count: view.inlineImageCount,
                size: format.number(Math.round((view.inlineImageBytes ?? 0) / 1024)),
              })}
            </Row>
          )}
          {view.smtpCode === null ? null : (
            <Row label={t('output.smtp')}>
              <span className="font-mono text-[12px]">
                {[view.smtpCode, view.smtpEnhanced].filter((part) => part !== null).join(' ')}
              </span>
            </Row>
          )}
        </Grid>
      );
    case 'notification':
      return (
        <Grid>
          <Row label={t('output.delivered')}>
            {t('output.people', { count: view.delivered ?? 0 })}
          </Row>
          {view.turnedOff === null || view.turnedOff === 0 ? null : (
            <Row label={t('output.turnedOff')}>{t('output.people', { count: view.turnedOff })}</Row>
          )}
          {view.summarized === null || view.summarized === 0 ? null : (
            <Row label={t('output.summarized')}>
              {t('output.people', { count: view.summarized })}
            </Row>
          )}
          {view.skipped.length === 0 ? null : (
            <Row label={t('output.skipped')}>
              <ul className="flex flex-col" data-testid="notification-skipped">
                {view.skipped.map((item) => (
                  <li key={item.userId}>
                    {userName(item.userId) ?? t('output.unknownUser')}
                    {': '}
                    {t(`output.skipReason.${item.reason}`, { defaultValue: item.reason })}
                  </li>
                ))}
              </ul>
            </Row>
          )}
        </Grid>
      );
    case 'other':
      return (
        <Grid>
          {view.entries.map(([key, value]) => (
            <Row key={key} label={key}>
              <span className="font-mono text-[12px]">{value}</span>
            </Row>
          ))}
        </Grid>
      );
  }
}

/**
 * What a step returned (board "S5 · Run history"): records found with the
 * values the viewer may read now ("Hidden (no permission)" for the rest),
 * the `if` branch, update counts, the `delay` time, email recipients
 * (masked by the server) and notification recipients who were skipped and
 * why — never rendered content (CONTRACTS §21).
 */
export function StepOutput({
  step,
  action,
  baseId,
  userName,
}: {
  readonly step: AutomationRunStepDto;
  readonly action: AutomationAction | null;
  readonly baseId: string;
  readonly userName: (userId: string) => string | null;
}) {
  const { t } = useTranslation('automationRuns');
  const view = stepOutputView(step.action_type ?? action?.type ?? null, step.output);
  const warnings = warningsOf(step.output);
  if (view === null && warnings.length === 0 && !step.redacted) return null;
  return (
    <div className="flex flex-col gap-2" data-testid={`step-output-${step.action_id}`}>
      {view === null ? (
        step.redacted ? (
          <p className="text-label font-normal">
            <HiddenValue />
          </p>
        ) : null
      ) : (
        <OutputBody view={view} baseId={baseId} tableId={tableOf(action)} userName={userName} />
      )}
      {warnings.length === 0 ? null : (
        <p className="text-label font-normal text-warning">
          {t('output.warnings', {
            list: warnings.map((code) => t(`warning.${code}`, { defaultValue: code })).join(', '),
          })}
        </p>
      )}
    </div>
  );
}
