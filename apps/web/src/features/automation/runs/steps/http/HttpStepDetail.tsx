import { cn } from '@cellhive/ui';
import { Info, Lock } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../../../lib/i18n/format';
import { runErrorText } from '../../components/RunBits';
import { HiddenValue } from '../../components/StepOutput';

import {
  allowlistHintOf,
  deliveryPhaseOf,
  httpResponseOf,
  MAX_DELIVERY_ATTEMPTS,
  type DeliveryPhase,
} from './model';

import type { StepDetailProps } from '../registry';
import type { AutomationRunError } from '@cellhive/contracts';

/** A delivery error: a step error code (unknown codes read as a generic sentence). */
type RunErrorLike = Pick<AutomationRunError, 'code' | 'params'>;

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Grid({ children, label }: { readonly children: ReactNode; readonly label?: string }) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-1 gap-x-3 gap-y-1 text-label font-normal sm:grid-cols-[minmax(7rem,9rem)_1fr]"
    >
      {children}
    </dl>
  );
}

const PHASE_TONE: Record<DeliveryPhase, string> = {
  queued: 'text-fg',
  retry: 'text-fg',
  paused: 'text-warning',
  sending: 'text-accent',
  succeeded: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-fg-muted',
};

/**
 * The delivery log of an HTTP step in the run drawer (BACKLOG T614; board
 * "S5c · Delivery log" not drawn yet — built from the step rows of FRONTEND
 * §13.3): the destination host, attempts out of six, where the delivery
 * stands (next retry, paused because the destination asked to wait), the
 * last HTTP status and error as a sentence, what to do about a blocked
 * address, and the response once it succeeded — its body as the server
 * redacted it for the viewer ("Hidden (no permission)"), cut at 10 KB.
 * Never the full URL, headers or the request body (CONTRACTS §25.5).
 */
export function HttpStepDetail({ step, userName }: StepDetailProps) {
  const { t } = useTranslation('automationRuns');
  const format = useFormatters();
  const bodyId = useId();
  const delivery = step.delivery;
  const response = httpResponseOf(step);
  const phase = delivery === undefined ? null : deliveryPhaseOf(delivery);
  const time = (value: string | null) =>
    value === null || Number.isNaN(Date.parse(value)) ? null : format.dateTime(value);
  const next = delivery === undefined ? null : time(delivery.next_attempt_at);
  const ongoing =
    delivery !== undefined && (delivery.status === 'pending' || delivery.status === 'sending');
  const hint = allowlistHintOf(step.error ?? delivery?.last_error ?? null);

  return (
    <div className="flex flex-col gap-2" data-testid={`http-step-${step.action_id}`}>
      {delivery === undefined || phase === null ? null : (
        <Grid label={t('http.delivery')}>
          <Row label={t('http.host')}>
            <span className="font-mono text-[12px] break-all" data-testid="http-host">
              {delivery.target_host}
            </span>
          </Row>
          <Row label={t('http.attempts')}>
            <span data-testid="http-attempts" className="tabular-nums">
              {t('http.attemptsValue', {
                attempts: format.number(delivery.attempts),
                max: format.number(MAX_DELIVERY_ATTEMPTS),
              })}
            </span>
          </Row>
          <Row label={t('http.state')}>
            <span
              className={cn('font-medium', PHASE_TONE[phase])}
              data-testid="http-phase"
              data-phase={phase}
            >
              {next === null || !ongoing
                ? t(`http.phase.${phase}`)
                : t(`http.phaseAt.${phase}`, { time: next })}
            </span>
          </Row>
          {delivery.last_status === null ? null : (
            <Row label={t('http.lastStatus')}>
              <span className="font-mono text-[12px]" data-testid="http-last-status">
                {t('http.statusCode', { status: delivery.last_status })}
              </span>
            </Row>
          )}
          {/* A final error is the step's error box; while retrying, the last one is here. */}
          {!ongoing || delivery.last_error === null ? null : (
            <Row label={t('http.lastError')}>
              <span data-testid="http-last-error">
                {runErrorText(delivery.last_error as RunErrorLike, { t, format, userName })}{' '}
                <span className="font-mono text-[12px] text-fg-muted">
                  {delivery.last_error.code}
                </span>
              </span>
            </Row>
          )}
        </Grid>
      )}
      {hint === null ? null : (
        <p
          className="flex items-start gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2 text-label font-normal"
          data-testid="http-ssrf-hint"
        >
          <Lock aria-hidden="true" className="mt-px size-4 shrink-0 text-fg-muted" />
          <span>{t(`http.ssrfHint.${hint}`)}</span>
        </p>
      )}
      {response === null ? null : (
        <section
          aria-label={t('http.response')}
          className="flex flex-col gap-1.5"
          data-testid="http-response"
        >
          <Grid>
            <Row label={t('http.responseStatus')}>
              <span className="font-mono text-[12px]">
                {response.status === null ? '—' : t('http.statusCode', { status: response.status })}
              </span>
            </Row>
            {response.contentType === null ? null : (
              <Row label={t('http.contentType')}>
                <span className="font-mono text-[12px] break-all">{response.contentType}</span>
              </Row>
            )}
            <Row label={t('http.body')}>
              {response.body.kind === 'hidden' ? (
                <span data-testid="http-body-hidden">
                  <HiddenValue />
                </span>
              ) : response.body.kind === 'empty' ? (
                <span className="text-fg-subtle">{t('http.bodyEmpty')}</span>
              ) : (
                <span className="text-fg-muted" id={bodyId}>
                  {response.truncated ? t('http.bodyTruncated') : t('http.bodyBelow')}
                </span>
              )}
            </Row>
          </Grid>
          {response.body.kind === 'text' ? (
            <pre
              // Scrollable, so it must take the focus (keyboard users scroll it too).
              tabIndex={0}
              aria-labelledby={bodyId}
              data-testid="http-body"
              className="max-h-64 overflow-auto rounded-md border border-line bg-surface-sunken p-2 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              {response.body.text}
            </pre>
          ) : null}
        </section>
      )}
      <p className="flex items-start gap-1.5 text-label font-normal text-fg-muted">
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {t('http.privacy')}
      </p>
    </div>
  );
}
