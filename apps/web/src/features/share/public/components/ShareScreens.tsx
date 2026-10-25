import { Button, Input, Spinner } from '@cellhive/ui';
import { CircleAlert, Clock, LinkIcon, LockKeyhole, SearchX } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { isApiError } from '../../../../lib/api/client';
import { retryAfterText, translateError } from '../../../../lib/errors/translate';

import type { ShareApi } from '../api';

/** Full-page placeholder while the link opens. */
export function ShareLoading() {
  const { t } = useTranslation('sharePage');
  return (
    <main className="flex flex-1 items-center justify-center gap-2 p-6 text-fg-muted">
      <Spinner />
      <span role="status">{t('loading')}</span>
    </main>
  );
}

export type ShareStatus = 'notFound' | 'gone' | 'rateLimited' | 'error';

const STATUS_ICONS = {
  notFound: SearchX,
  gone: LinkIcon,
  rateLimited: Clock,
  error: CircleAlert,
} as const;

/**
 * A link that cannot be shown (FRONTEND §2): unknown (`404`, same screen as
 * "no access" — an org link for someone outside the organization), no longer
 * valid (`410`: revoked, off, expired, replaced; one screen, no reason,
 * CONTRACTS §16), too many requests (`429`) or another failure.
 */
export function ShareStatusScreen({
  status,
  onRetry,
}: {
  status: ShareStatus;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation('sharePage');
  const Icon = STATUS_ICONS[status];
  const title = t(`status.${status}.title`);
  useDocumentTitle(title);
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <Icon aria-hidden="true" className="size-8 text-fg-muted" />
      <h1 className="text-title">{title}</h1>
      <p className="max-w-md text-fg-muted">{t(`status.${status}.description`)}</p>
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          {t('status.retry')}
        </Button>
      )}
    </main>
  );
}

/**
 * The password of a protected link (CONTRACTS §16A): `unlock` sets the
 * link's cookie (24 h) and the page opens. A wrong password says so; after
 * 5 wrong passwords in 15 minutes the IP is locked out of the link for 15
 * minutes (`429` + `Retry-After`): the form waits that long.
 */
export function SharePasswordScreen({
  api,
  onUnlocked,
}: {
  api: ShareApi;
  onUnlocked: () => void;
}) {
  const { t, i18n } = useTranslation('sharePage');
  const inputId = useId();
  const messageId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ReactNode>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  useDocumentTitle(t('password.title'));

  useEffect(() => {
    if (lockedUntil === null) return;
    const timer = window.setTimeout(
      () => {
        setLockedUntil(null);
        setMessage(null);
      },
      Math.max(0, lockedUntil - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [lockedUntil]);

  const locked = lockedUntil !== null;
  const onSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || locked) return;
    if (password === '') {
      setMessage(t('password.required'));
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api.unlock(password);
      onUnlocked();
    } catch (error) {
      setPassword('');
      if (isApiError(error) && error.code === 'SHARE_PASSWORD_INVALID') {
        setMessage(t('password.invalid'));
      } else if (isApiError(error) && error.status === 429) {
        const seconds = error.retry_after ?? 15 * 60;
        setLockedUntil(Date.now() + seconds * 1000);
        setMessage(`${t('password.locked')} ${retryAfterText(i18n, seconds)}`);
      } else {
        setMessage(translateError(error, i18n).message);
      }
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex flex-1 items-start justify-center px-4 pt-12 pb-16 sm:pt-20">
      <form
        noValidate
        aria-labelledby={`${inputId}-title`}
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-line bg-surface p-6"
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        <LockKeyhole aria-hidden="true" className="size-6 text-accent" />
        <h1 id={`${inputId}-title`} className="text-title">
          {t('password.title')}
        </h1>
        <p className="text-fg-muted">{t('password.description')}</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-label">
            {t('password.label')}
          </label>
          <Input
            ref={input}
            id={inputId}
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            disabled={locked}
            aria-invalid={message !== null}
            aria-describedby={message === null ? undefined : messageId}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          <p
            id={messageId}
            role="alert"
            className="min-h-5 text-label font-normal text-danger"
            data-testid="share-password-message"
          >
            {message}
          </p>
        </div>
        <Button type="submit" disabled={busy || locked}>
          {busy ? <Spinner /> : null}
          {busy ? t('password.submitting') : t('password.submit')}
        </Button>
      </form>
    </main>
  );
}
