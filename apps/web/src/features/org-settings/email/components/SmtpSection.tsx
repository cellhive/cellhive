import { Button, Spinner } from '@cellhive/ui';
import { CircleCheck, CircleX, Send, ServerOff, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useTestConnection } from '../api';
import { connectionTestView, testsLeft, TEST_WINDOW_MS } from '../model/connection-test';

import { Definition, DefinitionGrid, NoteBox, SettingsSection } from './SettingsSection';

import type { EmailSettingsDto, EmailTestResult } from '@cellhive/contracts';

/** Example of the variables in the "not configured" state (SPEC §20). */
const ENV_EXAMPLE = [
  'SMTP_URL=smtps://user:password@smtp.example.com:465',
  'SMTP_FROM="Example <no-reply@example.com>"',
  'SMTP_ALLOWED_FROM_DOMAINS=example.com',
  'EMAIL_AUTOMATION_FOOTER=required',
].join('\n');

function StatusBadge({ configured }: { readonly configured: boolean }) {
  const { t } = useTranslation('emailSettings');
  return (
    <span
      data-testid="smtp-status"
      className="inline-flex h-6 items-center gap-1 rounded-sm border border-line bg-surface-sunken px-2 text-label font-medium whitespace-nowrap text-fg"
    >
      {configured ? (
        <CircleCheck aria-hidden="true" className="size-3.5 text-success" />
      ) : (
        <TriangleAlert aria-hidden="true" className="size-3.5 text-warning" />
      )}
      {configured ? t('smtp.configured') : t('smtp.notConfigured')}
    </span>
  );
}

function fromText(smtp: EmailSettingsDto['smtp']): string {
  if (smtp.from === null) return '';
  return smtp.from_name === null || smtp.from_name === ''
    ? smtp.from
    : `${smtp.from_name} <${smtp.from}>`;
}

/** `HH:mm` of `date` in the user's language and time zone. */
function useTimeFormat(timeZone: string): (date: Date) => string {
  const { i18n } = useTranslation();
  const format = new Intl.DateTimeFormat(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  });
  return (date) => format.format(date);
}

function TestResult({
  result,
  at,
  timeZone,
}: {
  readonly result: EmailTestResult;
  readonly at: Date;
  readonly timeZone: string;
}) {
  const { t } = useTranslation('emailSettings');
  const time = useTimeFormat(timeZone);
  const view = connectionTestView(result);
  return (
    <NoteBox
      tone={view.ok ? 'success' : 'danger'}
      data-testid="test-result"
      icon={view.ok ? <CircleCheck /> : <CircleX />}
      title={t(view.messageKey)}
    >
      {view.ok && result.status === 'sent'
        ? t(view.hintKey, { to: result.to, time: time(at) })
        : t(view.hintKey)}
      {view.reply === null ? null : (
        <>
          {' '}
          <span data-testid="test-reply">
            <Trans
              t={t}
              i18nKey="test.reply"
              values={{ reply: view.reply }}
              components={{ code: <code className="font-mono text-mono" /> }}
            />
          </span>
        </>
      )}
    </NoteBox>
  );
}

/**
 * Read-only status of the instance SMTP (CONTRACTS §23.2) with "Test
 * connection" (a fixed email to the caller, classified result per reason),
 * or how to configure it with environment variables.
 */
export function SmtpSection({
  orgId,
  settings,
  email,
  timeZone,
}: {
  readonly orgId: string;
  readonly settings: EmailSettingsDto;
  /** The caller's address: the test goes there only. */
  readonly email: string;
  readonly timeZone: string;
}) {
  const { t } = useTranslation('emailSettings');
  const { smtp, limits } = settings;
  const test = useTestConnection(orgId);
  const [sentAt, setSentAt] = useState<readonly number[]>([]);
  const [last, setLast] = useState<{ result: EmailTestResult; at: Date } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Recount the tests left once the oldest one leaves the one-minute window.
  useEffect(() => {
    const oldest = sentAt.find((time) => now - time < TEST_WINDOW_MS);
    if (oldest === undefined) return;
    const timer = window.setTimeout(
      () => {
        setNow(Date.now());
      },
      oldest + TEST_WINDOW_MS - now,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [sentAt, now]);
  const left = testsLeft(sentAt, limits.test_sends_per_minute, now);

  return (
    <SettingsSection
      data-testid="smtp"
      title={t('smtp.title')}
      description={t('smtp.description')}
      badge={<StatusBadge configured={smtp.configured} />}
    >
      {smtp.configured ? (
        <>
          <DefinitionGrid>
            <Definition term={t('smtp.host')} data-testid="smtp-host">
              <span className="font-mono">{smtp.host}</span>
            </Definition>
            <Definition term={t('smtp.port')} data-testid="smtp-port">
              {smtp.port === null || smtp.security === null
                ? '—'
                : t('smtp.portValue', {
                    port: smtp.port,
                    security: t(`smtp.security.${smtp.security}`),
                  })}
            </Definition>
            <Definition term={t('smtp.from')} data-testid="smtp-from">
              {fromText(smtp)}
            </Definition>
            <Definition term={t('smtp.allowedDomains')} data-testid="smtp-domains">
              <span className="flex flex-col gap-0.5">
                <span>
                  {smtp.allowed_from_domains.length === 0
                    ? t('smtp.none')
                    : smtp.allowed_from_domains.join(', ')}
                </span>
                <span className="text-label font-normal text-fg-muted">
                  {t('smtp.allowedDomainsHint')}
                </span>
              </span>
            </Definition>
          </DefinitionGrid>
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                variant="secondary"
                data-testid="test-connection"
                disabled={test.isPending}
                className="max-sm:w-full"
                onClick={() => {
                  setLast(null);
                  test.mutate(undefined, {
                    onSuccess: (result) => {
                      const at = new Date();
                      setSentAt((times) => [...times, at.getTime()]);
                      setNow(at.getTime());
                      setLast({ result, at });
                    },
                  });
                }}
              >
                {test.isPending ? <Spinner /> : <Send aria-hidden="true" />}
                {test.isPending ? t('test.testing') : t('test.button')}
              </Button>
              <span className="text-label font-normal text-fg-muted" data-testid="test-hint">
                {t('test.hint', { email, count: left })}
              </span>
            </div>
            <div role="status" aria-live="polite" className="flex flex-col gap-2">
              {test.isPending ? (
                <span className="text-label font-normal text-fg-muted">
                  {smtp.host === null
                    ? t('test.progressNoHost')
                    : t('test.progress', { host: `${smtp.host}:${String(smtp.port ?? '')}` })}
                </span>
              ) : last === null ? null : (
                <TestResult result={last.result} at={last.at} timeZone={timeZone} />
              )}
            </div>
            {test.isError ? <ErrorAlert error={test.error} /> : null}
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3" data-testid="smtp-missing">
          <NoteBox tone="warning" icon={<ServerOff />} title={t('smtp.missing.title')}>
            {t('smtp.missing.body')}
          </NoteBox>
          <figure className="m-0 flex flex-col gap-1">
            <figcaption className="text-label font-normal text-fg-muted">
              {t('smtp.missing.example')}
            </figcaption>
            <pre className="m-0 overflow-x-auto rounded-md bg-surface-sunken p-3 font-mono text-mono leading-relaxed break-all whitespace-pre-wrap text-fg">
              {ENV_EXAMPLE}
            </pre>
          </figure>
          <p className="text-label font-normal text-fg-muted">{t('smtp.missing.docs')}</p>
        </div>
      )}
    </SettingsSection>
  );
}
