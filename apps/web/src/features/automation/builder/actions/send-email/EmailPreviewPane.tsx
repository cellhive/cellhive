import {
  type AutomationEmailPreview,
  type AutomationEmailTestResult,
  type SendEmailConfig,
} from '@cellhive/contracts';
import { Button, cn, Input, Select, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, type UseQueryResult } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Info, Send, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { automationsApi } from '../../../../../lib/api/automations';
import { isApiError } from '../../../../../lib/api/client';
import { formatBytes } from '../../../../../lib/attachments/format';
import { ErrorAlert } from '../../../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../../../lib/errors/translate';
import { EmailPreviewFrame } from '../../../template-editor/EmailPreviewFrame';

import {
  attachmentBytes,
  htmlBytes,
  readableAddress,
  testPrefix,
  testSendsLeft,
  testSendWaitSeconds,
  type EmailLimits,
} from './model';

const TEST_CHECK_ATTACHMENTS = 'check-attachments';
const TEST_CHECK_EXTERNAL = 'check-external';
const TEST_CHECK_MAY_NOT_READ = 'check-may-not-read';
const TEST_CHECK_RENDER = 'check-render';

type Tab = 'html' | 'text' | 'headers';

/** A text parameter of a problem or warning, else `fallback`. */
function textParam(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}
const TABS: readonly Tab[] = ['html', 'text', 'headers'];

export interface SampleRecord {
  readonly id: string;
  readonly title: string;
}

export interface EmailPreviewPaneProps {
  readonly automationId: string | null;
  readonly actionId: string;
  readonly config: SendEmailConfig;
  readonly preview: UseQueryResult<AutomationEmailPreview>;
  /** Why there is no preview yet (`null`: it is loading or shown). */
  readonly blocked: 'not_saved' | 'incomplete' | 'no_records' | null;
  /** Sample records of the trigger table; `null` when the trigger has no record. */
  readonly records: readonly SampleRecord[] | null;
  readonly recordsLoading: boolean;
  readonly recordId: string | null;
  readonly onRecord: (recordId: string) => void;
  /** Search of the sample records (primary field). */
  readonly recordSearch: string;
  readonly onRecordSearch: (search: string) => void;
  readonly limits: EmailLimits;
  readonly orgLocale: string | null | undefined;
  readonly meEmail: string | null;
  /** Name of a field of the trigger table (warnings name fields by id). */
  readonly fieldName: (fieldId: string) => string | null;
  readonly onSmtpMissing: () => void;
}

/** Problems of a `422` of the preview or the test, translated, REGEX with its way out. */
function ProblemList({ error }: { readonly error: unknown }) {
  const { t, i18n } = useTranslation(['automationEmail', 'errors']);
  if (!isApiError(error) || error.status !== 422 || error.errors.length === 0) {
    return <ErrorAlert error={error} />;
  }
  const regex = error.errors.some((item) => item.code === 'UNSUPPORTED_FUNCTION');
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5 text-label font-normal text-fg"
      data-testid="preview-problems"
    >
      <strong className="flex items-center gap-1.5 font-semibold text-danger">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
        {t('preview.invalid')}
      </strong>
      <ul className="flex list-disc flex-col gap-0.5 pl-5">
        {error.errors.map((item, index) => (
          <li key={`${item.path}-${String(index)}`}>
            {item.code === 'UNSUPPORTED_FUNCTION'
              ? t('regex.title', { name: textParam(item.params?.['function'], 'REGEX') })
              : translateDetail(i18n, item)}
          </li>
        ))}
      </ul>
      {regex ? <p data-testid="regex-hint">{t('regex.hint')}</p> : null}
    </div>
  );
}

function CheckItem({
  tone,
  children,
  testId,
}: {
  readonly tone: 'ok' | 'warning' | 'danger';
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  const Icon = tone === 'ok' ? CircleCheck : tone === 'warning' ? TriangleAlert : CircleAlert;
  return (
    <li className="flex items-start gap-2" data-testid={testId}>
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'ok' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-danger',
        )}
      />
      <span>{children}</span>
    </li>
  );
}

/**
 * Right half of the wide email editor (board "S5 · Email template editor",
 * "… - tab và lỗi"): the sample record, the email as recipients get it
 * (HTML in a sandboxed frame, the plain-text part, the headers), "Send a
 * test to me" with the sends left this minute, and the checks of the
 * server on that record (size, recipients, people who may not read some
 * fields, external addresses, files).
 */
export function EmailPreviewPane({
  automationId,
  actionId,
  config,
  preview,
  blocked,
  records,
  recordsLoading,
  recordId,
  onRecord,
  recordSearch,
  onRecordSearch,
  limits,
  orgLocale,
  meEmail,
  fieldName,
  onSmtpMissing,
}: EmailPreviewPaneProps) {
  const { t, i18n } = useTranslation(['automationEmail', 'errors']);
  const id = useId();
  const [tab, setTab] = useState<Tab>('html');
  const [sentAt, setSentAt] = useState<number[]>([]);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<AutomationEmailTestResult | null>(null);
  const number = new Intl.NumberFormat(i18n.language);
  const bytes = (value: number) => formatBytes(value, i18n.language);

  // A clock for "N left this minute" and "try again in N s" while either matters.
  const ticking = sentAt.some((time) => now - time < 60_000) || (blockedUntil ?? 0) > now;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [ticking]);

  const test = useMutation({
    mutationFn: () =>
      automationsApi.emailTest(automationId ?? '', actionId, {
        record_id: recordId,
        draft: config,
      }),
    onMutate: () => {
      setResult(null);
    },
    onSuccess: (outcome) => {
      const time = Date.now();
      setNow(time);
      setSentAt((current) => [...current.filter((item) => time - item < 60_000), time]);
      setResult(outcome);
    },
    onError: (error) => {
      const time = Date.now();
      setNow(time);
      if (isApiError(error) && error.status === 429) {
        setBlockedUntil(time + (error.retry_after ?? 60) * 1000);
      }
      if (isApiError(error) && error.code === 'SMTP_NOT_CONFIGURED') onSmtpMissing();
    },
  });

  const left = testSendsLeft(sentAt, now, limits.testSendsPerMinute);
  const waitFromServer =
    blockedUntil === null ? 0 : Math.max(0, Math.ceil((blockedUntil - now) / 1000));
  const wait = Math.max(waitFromServer, left === 0 ? testSendWaitSeconds(sentAt, now) : 0);
  const limited = wait > 0;
  const data = preview.data;
  const canTest = automationId !== null && blocked === null && !test.isPending && !limited;
  const recordTitle = records?.find((record) => record.id === recordId)?.title ?? recordId ?? null;

  const warnings = data?.warnings ?? [];
  const warning = (code: string) => warnings.find((item) => item.code === code);
  const mayNotRead = warning('RECIPIENT_MAY_NOT_READ');
  const external = warning('EXTERNAL_RECIPIENTS');
  const size = warning('ATTACHMENTS_SIZE');
  const unavailable = warning('ATTACHMENTS_UNAVAILABLE');
  const onBehalf = warning('ON_BEHALF_DMARC');
  const fieldsOf = (ids: unknown) =>
    (Array.isArray(ids) ? ids : [])
      .map((item) => fieldName(String(item)) ?? t('preview.hiddenField'))
      .join(', ');

  const tabButton = (value: Tab) => (
    <button
      key={value}
      type="button"
      role="tab"
      id={`${id}-${value}`}
      aria-selected={tab === value}
      aria-controls={`${id}-panel`}
      tabIndex={tab === value ? 0 : -1}
      className={cn(
        '-mb-px min-h-9 border-b-2 px-3 py-1.5 text-body font-medium max-lg:min-h-control',
        tab === value ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
      )}
      onClick={() => {
        setTab(value);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const index = TABS.indexOf(value);
        const next =
          TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length] ??
          'html';
        setTab(next);
        document.getElementById(`${id}-${next}`)?.focus();
      }}
    >
      {t(`preview.tabs.${value}`)}
    </button>
  );

  let body: ReactNode;
  if (blocked !== null) {
    body = (
      <p
        className="flex items-start gap-2 px-6 py-6 text-body text-fg-muted"
        data-testid="preview-blocked"
      >
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t(`preview.blocked.${blocked}`)}
      </p>
    );
  } else if (preview.isError && data === undefined) {
    body = (
      <div className="px-6 py-4">
        <ProblemList error={preview.error} />
      </div>
    );
  } else if (data === undefined) {
    body = (
      <div
        role="status"
        aria-busy="true"
        aria-label={t('preview.loading')}
        className="flex flex-col gap-3 px-6 py-6"
      >
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  } else {
    const headerRows: [string, ReactNode][] = [
      [t('preview.headers.from'), readableAddress(data.headers.from)],
      [
        t('preview.headers.replyTo'),
        data.headers.reply_to === null ? '—' : readableAddress(data.headers.reply_to),
      ],
      [t('preview.headers.to'), data.recipients.to.join(', ') || '—'],
      [t('preview.headers.cc'), data.recipients.cc.join(', ') || '—'],
      [t('preview.headers.bcc'), data.recipients.bcc.join(', ') || '—'],
      [t('preview.headers.subject'), data.subject],
      ['Auto-Submitted', 'auto-generated'],
      ['X-Auto-Response-Suppress', 'OOF, AutoReply'],
      ['X-Cellhive-Automation', automationId ?? '—'],
      [
        t('preview.headers.footer'),
        data.footer === config.footer
          ? t(`footer.levels.${data.footer}`)
          : t('preview.footerApplied', { level: t(`footer.levels.${data.footer}`) }),
      ],
      [
        t('preview.headers.files'),
        data.attachments.length === 0
          ? '—'
          : t('preview.files', {
              count: data.attachments.length,
              size: bytes(attachmentBytes(data)),
            }),
      ],
    ];
    body = (
      <div
        className={cn('flex min-h-0 flex-1 flex-col', preview.isFetching && 'opacity-70')}
        aria-busy={preview.isFetching || undefined}
      >
        {preview.isError ? (
          <div className="px-6 pt-3">
            <ProblemList error={preview.error} />
          </div>
        ) : null}
        {tab === 'html' ? (
          <>
            <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-1 border-b border-line bg-surface px-6 py-3 text-label">
              <dt className="text-fg-muted">{t('preview.headers.from')}</dt>
              <dd className="break-words" data-testid="preview-from">
                {readableAddress(data.headers.from)}
              </dd>
              <dt className="text-fg-muted">{t('preview.headers.to')}</dt>
              <dd className="break-words">{data.recipients.to.join(', ') || '—'}</dd>
              {data.recipients.cc.length === 0 ? null : (
                <>
                  <dt className="text-fg-muted">{t('preview.headers.cc')}</dt>
                  <dd className="break-words">{data.recipients.cc.join(', ')}</dd>
                </>
              )}
              <dt className="text-fg-muted">{t('preview.headers.subject')}</dt>
              <dd className="font-medium break-words" data-testid="preview-subject">
                {data.subject}
              </dd>
            </dl>
            <p className="px-6 pt-2 text-label font-normal text-fg-muted">{t('preview.sandbox')}</p>
            <div className="p-3 sm:px-6">
              <EmailPreviewFrame
                html={data.html}
                images={data.images}
                title={t('preview.frameTitle', { subject: data.subject })}
                className="h-[560px] rounded-md border border-line"
              />
            </div>
            {data.attachments.length === 0 ? null : (
              <ul
                className="flex flex-wrap gap-1.5 px-6 pb-3"
                aria-label={t('preview.headers.files')}
              >
                {data.attachments.map((file, index) => (
                  <li
                    key={`${file.name}-${String(index)}`}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface px-2 py-1 text-label"
                  >
                    <span className="break-all">{file.name}</span>
                    <span className="font-normal text-fg-muted">{bytes(file.size)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
        {tab === 'text' ? (
          <div className="flex flex-col gap-2 px-6 py-4">
            <pre
              className="max-h-[560px] overflow-auto rounded-md border border-line bg-surface p-4 font-code text-label leading-relaxed break-words whitespace-pre-wrap"
              data-testid="preview-text"
            >
              {data.text}
            </pre>
            <p className="text-label font-normal text-fg-muted">{t('preview.textNote')}</p>
          </div>
        ) : null}
        {tab === 'headers' ? (
          <div className="flex flex-col gap-3 px-6 py-4">
            <dl
              className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-line bg-surface p-4 text-label"
              data-testid="preview-headers"
            >
              {headerRows.map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="font-code text-fg-muted">{name}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {onBehalf === undefined ? null : (
              <div
                role="note"
                className="flex gap-2.5 rounded-lg border border-warning/50 bg-option-3 px-3 py-2.5 text-label font-normal text-fg"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                <span className="flex flex-col gap-0.5">
                  <strong className="font-semibold">{t('preview.onBehalfTitle')}</strong>
                  <span>{t('preview.onBehalfBody')}</span>
                </span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  const testText = (() => {
    if (result === null) return null;
    if (result.status === 'sent') return t('test.sent', { to: result.to });
    const reason = result.reason ?? result.code;
    const code = [result.smtp.code, result.smtp.enhanced].filter((item) => item !== null).join(' ');
    return `${t(`test.failed.${reason}`)}${code === '' ? '' : ` ${t('test.smtpCode', { code })}`}`;
  })();

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-1 flex-col bg-canvas xl:min-h-0 xl:overflow-y-auto"
      data-testid="email-preview"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-6 py-3">
        <h2 id={`${id}-title`} className="text-heading">
          {t('preview.title')}
        </h2>
        {records === null ? (
          <span className="text-label font-normal text-fg-muted">
            {t('preview.noTriggerRecord')}
          </span>
        ) : (
          <span className="flex min-w-0 basis-full flex-wrap items-center gap-2">
            <label htmlFor={`${id}-record`} className="shrink-0 text-label text-fg-muted">
              {t('preview.record')}
            </label>
            <Select
              id={`${id}-record`}
              className="w-56 max-w-full"
              value={recordId ?? ''}
              disabled={recordsLoading || records.length === 0}
              data-testid="preview-record"
              onChange={(event) => {
                if (event.target.value !== '') onRecord(event.target.value);
              }}
            >
              {records.length === 0 ? (
                <option value="">
                  {recordsLoading ? t('preview.loading') : t('preview.noRecords')}
                </option>
              ) : null}
              {records.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.title === '' ? t('preview.untitled') : record.title}
                </option>
              ))}
            </Select>
            <Input
              type="search"
              className="w-40 max-w-full"
              value={recordSearch}
              aria-label={t('preview.searchRecord')}
              placeholder={t('preview.searchRecord')}
              data-testid="preview-record-search"
              onChange={(event) => {
                onRecordSearch(event.target.value);
              }}
            />
          </span>
        )}
      </div>
      <div
        role="tablist"
        aria-label={t('preview.tabsLabel')}
        className="flex border-b border-line bg-surface px-4"
      >
        {TABS.map(tabButton)}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        className="flex min-h-0 flex-col"
      >
        {body}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface px-6 py-3">
        <Button
          variant="secondary"
          disabled={!canTest}
          data-testid="email-test"
          onClick={() => {
            test.mutate();
          }}
        >
          {test.isPending ? <Spinner /> : <Send aria-hidden="true" />}
          {t('test.button')}
        </Button>
        <span className="flex min-w-0 flex-col text-label font-normal text-fg-muted">
          <span>
            {t('test.to', {
              email: meEmail ?? t('test.yourAddress'),
              prefix: testPrefix(orgLocale),
            })}
          </span>
          {limited ? null : (
            <span data-testid="test-left">
              {t('test.left', {
                count: left,
                formatted: number.format(left),
                max: number.format(limits.testSendsPerMinute),
              })}
            </span>
          )}
        </span>
        <div className="basis-full" role="status" aria-live="polite" data-testid="test-status">
          {limited ? (
            <span className="text-label font-normal text-fg">
              {t('test.limited', { max: limits.testSendsPerMinute, seconds: wait })}
            </span>
          ) : testText === null ? null : (
            <span
              className={cn(
                'text-label font-normal',
                result?.status === 'sent' ? 'text-fg' : 'text-danger',
              )}
            >
              {testText}
            </span>
          )}
        </div>
        {test.isError && !(isApiError(test.error) && test.error.status === 429) ? (
          <div className="basis-full">
            <ProblemList error={test.error} />
          </div>
        ) : null}
      </div>
      {data === undefined || blocked !== null ? null : (
        <section
          aria-labelledby={`${id}-checks`}
          className="border-t border-line bg-surface px-6 py-3"
        >
          <h3 id={`${id}-checks`} className="mb-2 text-label text-fg">
            {t('checks.title')}
          </h3>
          <ul className="flex flex-col gap-1.5 text-label font-normal" data-testid="preview-checks">
            <CheckItem
              tone={
                limits.maxHtmlBytes !== null && htmlBytes(data.html) > limits.maxHtmlBytes * 0.8
                  ? 'warning'
                  : 'ok'
              }
            >
              {limits.maxHtmlBytes === null
                ? t('checks.html', { size: bytes(htmlBytes(data.html)) })
                : t('checks.htmlMax', {
                    size: bytes(htmlBytes(data.html)),
                    max: bytes(limits.maxHtmlBytes),
                  })}
            </CheckItem>
            <CheckItem
              tone={
                data.recipients.count === 0 ||
                (limits.maxRecipients !== null && data.recipients.count > limits.maxRecipients)
                  ? 'danger'
                  : data.recipients.invalid > 0
                    ? 'warning'
                    : 'ok'
              }
            >
              {limits.maxRecipients === null
                ? t('checks.recipients', { count: data.recipients.count })
                : t('checks.recipientsMax', {
                    count: data.recipients.count,
                    max: number.format(limits.maxRecipients),
                  })}
              {data.recipients.invalid > 0
                ? ` ${t('checks.invalid', { count: data.recipients.invalid })}`
                : ''}
            </CheckItem>
            {external === undefined ? null : (
              <CheckItem tone="warning" testId={TEST_CHECK_EXTERNAL}>
                {t('checks.external', { count: Number(external.params?.['count'] ?? 0) })}
              </CheckItem>
            )}
            {mayNotRead === undefined ? null : (
              <CheckItem tone="warning" testId={TEST_CHECK_MAY_NOT_READ}>
                {mayNotRead.params?.['record'] === true
                  ? t('checks.mayNotReadRecord')
                  : t('checks.mayNotRead', { fields: fieldsOf(mayNotRead.params?.['field_ids']) })}
              </CheckItem>
            )}
            {onBehalf === undefined ? null : (
              <CheckItem tone="warning">{t('checks.onBehalf')}</CheckItem>
            )}
            {config.attachments.length === 0 ? null : unavailable !== undefined ? (
              <CheckItem tone="danger" testId={TEST_CHECK_ATTACHMENTS}>
                {t('checks.attachmentsUnavailable', {
                  reason: t(
                    `attachments.errors.${textParam(unavailable.params?.['code'], 'attachment_not_ready')}`,
                  ),
                })}
              </CheckItem>
            ) : (
              <CheckItem
                tone={size === undefined ? 'ok' : 'warning'}
                testId={TEST_CHECK_ATTACHMENTS}
              >
                {limits.maxAttachmentBytes === null
                  ? t('checks.files', {
                      count: data.attachments.length,
                      size: bytes(attachmentBytes(data)),
                    })
                  : t('checks.filesMax', {
                      count: data.attachments.length,
                      size: bytes(attachmentBytes(data)),
                      max: bytes(limits.maxAttachmentBytes),
                    })}
              </CheckItem>
            )}
            {data.render_warnings.length === 0 ? null : (
              <CheckItem tone="warning" testId={TEST_CHECK_RENDER}>
                {t('checks.render', { count: data.render_warnings.length })}
              </CheckItem>
            )}
          </ul>
          {recordTitle === null ? null : (
            <p className="mt-2 text-label font-normal text-fg-muted">
              {t('checks.with', { record: recordTitle })}
            </p>
          )}
        </section>
      )}
    </section>
  );
}
