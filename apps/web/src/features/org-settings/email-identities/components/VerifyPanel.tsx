import {
  EMAIL_VERIFICATION_CODE_LENGTH,
  EMAIL_VERIFICATION_SENDS_PER_DAY_PER_ORG,
  EMAIL_VERIFICATION_SENDS_PER_HOUR_PER_IDENTITY,
  type EmailIdentityDto,
  type EmailVerificationOutcome,
} from '@cellhive/contracts';
import { Button, cn, Input, Spinner } from '@cellhive/ui';
import { useMutation } from '@tanstack/react-query';
import { Circle, CircleCheck, CircleMinus, CircleX, RefreshCw, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { retryAfterText } from '../../../../lib/errors/translate';
import { useFormatters } from '../../../../lib/i18n/format';
import { emailIdentitiesApi } from '../api';
import { useIdentityCache } from '../hooks';
import {
  failureKey,
  normalizeCode,
  smtpCodeText,
  verificationSteps,
  type StepState,
} from '../model/verification';

import { Note } from './parts';

const STEP_ICON: Record<StepState, { icon: typeof Circle; className: string }> = {
  done: { icon: CircleCheck, className: 'text-success' },
  failed: { icon: CircleX, className: 'text-danger' },
  skipped: { icon: CircleMinus, className: 'text-fg-muted' },
  not_run: { icon: Circle, className: 'text-fg-muted' },
};

/** "Test & verify" of an identity with its own SMTP server: one line per step. */
function StepList({
  identity,
  outcome,
}: {
  readonly identity: EmailIdentityDto;
  readonly outcome: EmailVerificationOutcome;
}) {
  const { t } = useTranslation('emailIdentities');
  const steps = verificationSteps(outcome, identity.smtp?.security ?? null);
  if (steps === null || identity.smtp === null) return null;
  const smtp = identity.smtp;
  return (
    <ol
      aria-label={t('verify.steps.label')}
      className="flex flex-col gap-1.5"
      data-testid="verify-steps"
    >
      {steps.map(({ step, state }) => {
        const { icon: Icon, className } = STEP_ICON[state];
        return (
          <li key={step} data-step={step} data-state={state} className="flex items-start gap-2">
            <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', className)} />
            <span className="flex min-w-0 flex-col">
              <span className="break-words">
                {t(`verify.steps.${step}`, {
                  host: smtp.host,
                  port: smtp.port,
                  username: smtp.username,
                  email: identity.email,
                })}
              </span>
              <span className="text-label font-normal text-fg-muted">
                {t(`verify.stepState.${state}`)}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** What happened to the last verification email sent from this screen. */
function OutcomeNote({
  identity,
  outcome,
}: {
  readonly identity: EmailIdentityDto;
  readonly outcome: EmailVerificationOutcome;
}) {
  const { t, i18n } = useTranslation('emailIdentities');
  const format = useFormatters();
  if (outcome.status === 'rate_limited') {
    return (
      <Note tone="warning" role="alert" title={t('verify.rateLimited')}>
        {retryAfterText(i18n, outcome.retry_after_seconds)}
      </Note>
    );
  }
  if (outcome.status === 'sent') {
    return (
      <Note
        tone="success"
        role="status"
        title={t('verify.sent', { email: outcome.to })}
        data-testid="verify-sent"
      >
        <span>{t('verify.sentExpires', { date: format.dateTime(outcome.expires_at) })}</span>
        {identity.transport === 'smtp' ? <StepList identity={identity} outcome={outcome} /> : null}
      </Note>
    );
  }
  const key = failureKey(outcome);
  const code = smtpCodeText(outcome.smtp);
  return (
    <Note tone="danger" role="alert" title={t(`verify.failure.${key}`)} data-testid="verify-failed">
      {code === null ? null : (
        <span className="font-mono text-mono">{t('verify.smtpCode', { code })}</span>
      )}
      <span>{t(`verify.fix.${key}`)}</span>
      {identity.transport === 'smtp' ? <StepList identity={identity} outcome={outcome} /> : null}
    </Note>
  );
}

function CodeForm({
  identity,
  onVerified,
}: {
  readonly identity: EmailIdentityDto;
  readonly onVerified: (identity: EmailIdentityDto) => void;
}) {
  const { t } = useTranslation('emailIdentities');
  const id = useId();
  const [code, setCode] = useState('');
  const cache = useIdentityCache(identity.organization_id);
  const verify = useMutation({
    mutationFn: (value: string) => emailIdentitiesApi.verifyCode(identity.id, value),
    onSuccess: (updated) => {
      cache.put(updated);
      onVerified(updated);
    },
    onError: () => {
      // The attempts left and the pending state changed on the server.
      cache.refresh();
    },
  });
  const detail = isApiError(verify.error) ? verify.error.errors[0] : undefined;
  const locked = detail?.code === 'CODE_LOCKED';
  const wrong = detail?.code === 'CODE_INVALID';
  const attemptsLeft =
    wrong && typeof detail.params?.['attempts_left'] === 'number'
      ? detail.params['attempts_left']
      : null;
  const complete = code.length === EMAIL_VERIFICATION_CODE_LENGTH;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !verify.isPending) verify.mutate(code);
      }}
    >
      <label htmlFor={id} className="text-label text-fg">
        {t('verify.codeLabel')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          name="one-time-code"
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={EMAIL_VERIFICATION_CODE_LENGTH + 6}
          spellCheck={false}
          aria-invalid={wrong || locked}
          aria-describedby={`${id}-hint${verify.isError ? ` ${id}-error` : ''}`}
          data-testid="verify-code"
          className="h-11 w-44 text-center font-mono text-[18px] tracking-[0.4em]"
          onChange={(event) => {
            setCode(normalizeCode(event.target.value));
            if (verify.isError) verify.reset();
          }}
        />
        <Button type="submit" disabled={!complete || verify.isPending || locked}>
          {verify.isPending ? <Spinner /> : null}
          {t('verify.submit')}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
        {t('verify.codeHint')}
      </p>
      {verify.isError ? (
        <div id={`${id}-error`}>
          {wrong ? (
            <p
              role="alert"
              className="flex items-center gap-1.5 text-label font-normal text-danger"
            >
              <CircleX aria-hidden="true" className="size-3.5 shrink-0" />
              {attemptsLeft === null
                ? t('verify.wrongCode')
                : t('verify.wrongCodeLeft', { count: attemptsLeft })}
            </p>
          ) : locked ? (
            <Note tone="danger" role="alert" title={t('verify.lockedTitle')}>
              {t('verify.locked')}
            </Note>
          ) : (
            <ErrorAlert error={verify.error} />
          )}
        </div>
      ) : null}
    </form>
  );
}

export interface VerifyPanelProps {
  readonly identity: EmailIdentityDto;
  /** The answer of the last send from this screen (create, change, resend, test). */
  readonly outcome: EmailVerificationOutcome | null;
  readonly onOutcome: (outcome: EmailVerificationOutcome) => void;
  readonly onVerified: (identity: EmailIdentityDto) => void;
}

/**
 * Verification of an identity (ADR-33 §2, board "S5 · Email identities -
 * xác minh"): what was sent and what failed (per step for an own SMTP
 * server), the 6-digit code, and sending again ("Test & verify" for an own
 * SMTP server). Confirming the link in the mailbox works too; this screen
 * learns it when the list is fetched again.
 */
export function VerifyPanel({ identity, outcome, onOutcome, onVerified }: VerifyPanelProps) {
  const { t, i18n } = useTranslation('emailIdentities');
  const cache = useIdentityCache(identity.organization_id);
  const smtp = identity.transport === 'smtp';
  const resend = useMutation({
    mutationFn: () =>
      smtp
        ? emailIdentitiesApi.testAndVerify(identity.id)
        : emailIdentitiesApi.sendVerification(identity.id),
    onSuccess: (result) => {
      onOutcome(result);
      cache.refresh();
    },
  });
  const verifiable = identity.status === 'pending' || identity.status === 'error';
  const resendError =
    isApiError(resend.error) && resend.error.status === 429 ? (
      <Note tone="warning" role="alert" title={t('verify.rateLimited')}>
        {resend.error.retry_after === undefined
          ? null
          : retryAfterText(i18n, resend.error.retry_after)}
      </Note>
    ) : resend.isError ? (
      <ErrorAlert error={resend.error} />
    ) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="verify-panel">
      {identity.status === 'verified' ? (
        <Note
          tone="success"
          role="status"
          title={t('verify.done', { email: identity.email })}
          data-testid="verify-done"
        >
          {t('verify.doneHint')}
        </Note>
      ) : identity.status === 'disabled' ? (
        <Note tone="info" title={t('verify.disabled')} />
      ) : (
        <p className="text-body text-fg-muted">
          {smtp && identity.smtp !== null
            ? t('verify.introSmtp', {
                host: identity.smtp.host,
                username: identity.smtp.username,
                email: identity.email,
              })
            : t('verify.intro', { email: identity.email })}
        </p>
      )}
      {identity.status === 'error' ? (
        <Note tone="danger" title={t(`statusLine.error_${identity.error_reason ?? 'auth_failed'}`)}>
          {t('verify.errorFix')}
        </Note>
      ) : null}
      {outcome === null || identity.status === 'verified' ? null : (
        <OutcomeNote identity={identity} outcome={outcome} />
      )}
      {verifiable && identity.verification.pending ? (
        <CodeForm
          key={identity.verification.sent_at ?? ''}
          identity={identity}
          onVerified={onVerified}
        />
      ) : null}
      {verifiable ? (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={smtp ? 'primary' : 'secondary'}
              disabled={resend.isPending}
              data-testid="verify-resend"
              onClick={() => {
                resend.mutate();
              }}
            >
              {resend.isPending ? (
                <Spinner />
              ) : smtp ? (
                <ShieldCheck aria-hidden="true" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              {smtp ? t('verify.test') : t('verify.resend')}
            </Button>
            <span className="text-label font-normal text-fg-muted">
              {t('verify.limits', {
                perHour: EMAIL_VERIFICATION_SENDS_PER_HOUR_PER_IDENTITY,
                perDay: EMAIL_VERIFICATION_SENDS_PER_DAY_PER_ORG,
              })}
            </span>
          </div>
          {resendError}
          <p className="text-label font-normal text-fg-muted">{t('verify.linkNote')}</p>
        </div>
      ) : null}
    </div>
  );
}
