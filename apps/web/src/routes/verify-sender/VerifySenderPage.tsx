import {
  emailVerificationConfirmedSchema,
  emailVerificationPreviewSchema,
} from '@cellhive/contracts';
import { Button, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, Link2Off } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../lib/a11y/use-document-title';
import { apiRequest, isApiError, UNCHECKED_SCHEMA } from '../../lib/api/client';
import { ErrorAlert } from '../../lib/errors/ErrorAlert';
import { retryAfterText } from '../../lib/errors/translate';
import { useFormatters } from '../../lib/i18n/format';

import type { ReactNode } from 'react';

/**
 * Public calls of the page (CONTRACTS §23.3): the token travels in the body
 * only. Responses are checked against the contract in development only, so
 * this light entry carries no zod schema in production (FRONTEND §11.1).
 */
const verifySenderApi = {
  preview: (token: string, signal?: AbortSignal) =>
    apiRequest(
      '/email-identities/verify/preview',
      import.meta.env.DEV ? emailVerificationPreviewSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body: { token }, signal },
    ),
  confirm: (token: string) =>
    apiRequest(
      '/email-identities/verify',
      import.meta.env.DEV ? emailVerificationConfirmedSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body: { token } },
    ),
};

function isInvalidToken(error: unknown): boolean {
  return isApiError(error) && error.code === 'EMAIL_VERIFICATION_INVALID';
}

function isRateLimited(error: unknown): boolean {
  return isApiError(error) && error.status === 429;
}

/** Initials of the organization for its badge ("Công ty Bán Hàng" → "CB"). */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  return letters.join('').toLocaleUpperCase();
}

/** The card of the page; its title is the document title too. */
function Panel({
  title,
  children,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly 'data-testid': string;
}) {
  useDocumentTitle(title);
  return (
    <section
      data-testid={testId}
      className="flex w-full max-w-[520px] flex-col gap-4 rounded-lg border border-line bg-surface px-4 py-5 sm:px-8 sm:py-7"
    >
      {children}
    </section>
  );
}

const OUTCOMES = {
  done: { icon: CircleCheck, className: 'text-success' },
  invalid: { icon: Link2Off, className: 'text-fg-muted' },
  expired: { icon: Clock, className: 'text-warning' },
  rateLimited: { icon: CircleX, className: 'text-danger' },
} as const;

/** A final state of the page: icon, title, one sentence. */
function Outcome({
  variant,
  title,
  children,
}: {
  readonly variant: keyof typeof OUTCOMES;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const { icon: Icon, className } = OUTCOMES[variant];
  return (
    <Panel title={title} data-testid={`verify-sender-${variant}`}>
      <div className="flex items-start gap-3" role="status">
        <Icon aria-hidden="true" className={`mt-0.5 size-6 shrink-0 ${className}`} />
        <div className="flex flex-col gap-1">
          <h1 className="text-heading">{title}</h1>
          <div className="text-body leading-relaxed text-fg-muted">{children}</div>
        </div>
      </div>
    </Panel>
  );
}

/**
 * `/verify-sender?token=…` (T530/T533, ADR-33 §2; board "S5 · Sender
 * verification page" + 375 px): no sign-in needed, served by the light
 * public entry (`share.html`, no app shell). Opening the link only shows
 * who asks to send as which address; the address is confirmed by the
 * button (`POST`), so link scanners that open it confirm nothing.
 */
export function VerifySenderPage() {
  const { t, i18n } = useTranslation('verifySender');
  const format = useFormatters();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const preview = useQuery({
    queryKey: ['verify-sender', token],
    queryFn: ({ signal }) => verifySenderApi.preview(token, signal),
    // Expired between the email and opening the page (the server refuses it anyway).
    select: (data) => ({ ...data, expired: Date.parse(data.expires_at) <= Date.now() }),
    enabled: token !== '',
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const confirm = useMutation({
    mutationFn: () => verifySenderApi.confirm(token),
    meta: { ignoreUnauthenticated: true },
  });

  let content: ReactNode;
  if (confirm.isSuccess) {
    content = (
      <Outcome variant="done" title={t('doneTitle')}>
        {preview.data === undefined
          ? t('doneShort', { email: confirm.data.email })
          : t('done', { email: confirm.data.email, org: preview.data.organization_name })}
      </Outcome>
    );
  } else if (token === '' || isInvalidToken(preview.error) || isInvalidToken(confirm.error)) {
    content = (
      <Outcome variant="invalid" title={t('invalidTitle')}>
        {t('invalid')}
      </Outcome>
    );
  } else if (preview.data?.expired === true) {
    content = (
      <Outcome variant="expired" title={t('expiredTitle')}>
        {t('expired')}
      </Outcome>
    );
  } else if (isRateLimited(preview.error) || isRateLimited(confirm.error)) {
    const error = preview.error ?? confirm.error;
    const seconds = isApiError(error) ? error.retry_after : undefined;
    content = (
      <Outcome variant="rateLimited" title={t('rateLimitedTitle')}>
        {seconds === undefined ? t('rateLimited') : retryAfterText(i18n, seconds)}
      </Outcome>
    );
  } else if (preview.isPending) {
    content = (
      <Panel title={t('title')} data-testid="verify-sender-loading">
        <div
          role="status"
          aria-busy="true"
          aria-label={t('loading')}
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-20" />
          <Skeleton className="h-10" />
        </div>
      </Panel>
    );
  } else if (preview.isError) {
    content = (
      <Panel title={t('title')} data-testid="verify-sender-error">
        <h1 className="text-heading">{t('title')}</h1>
        <ErrorAlert error={preview.error} />
        <Button
          variant="secondary"
          onClick={() => {
            void preview.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Panel>
    );
  } else {
    const data = preview.data;
    content = (
      <Panel title={t('title')} data-testid="verify-sender-page">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent font-semibold text-on-accent"
          >
            {initialsOf(data.organization_name)}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold break-words">{data.organization_name}</span>
            <span className="text-label font-normal text-fg-muted">{t('onCellhive')}</span>
          </span>
        </div>
        <h1 className="text-title">{t('title')}</h1>
        <p className="text-body leading-relaxed text-fg-muted max-sm:text-[15px]">
          {data.requested_by === null
            ? t('ask', { org: data.organization_name, email: data.email })
            : t('askBy', {
                org: data.organization_name,
                email: data.email,
                name: data.requested_by,
              })}
        </p>
        <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md bg-surface-sunken p-3 text-body">
          <dt className="text-fg-muted">{t('displayName')}</dt>
          <dd className="break-words">{data.display_name}</dd>
          <dt className="text-fg-muted">{t('address')}</dt>
          <dd className="break-all">{data.email}</dd>
          <dt className="text-fg-muted">{t('expires')}</dt>
          <dd>{format.dateTime(data.expires_at)}</dd>
        </dl>
        {confirm.isError ? <ErrorAlert error={confirm.error} /> : null}
        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!confirm.isPending) confirm.mutate();
          }}
        >
          <Button
            type="submit"
            className="h-10 max-sm:h-11 max-sm:text-[15px]"
            disabled={confirm.isPending}
            data-testid="verify-sender-confirm"
          >
            {confirm.isPending ? <Spinner /> : null}
            {t('confirm')}
          </Button>
        </form>
        <p className="text-label font-normal text-fg-muted">{t('ignore')}</p>
      </Panel>
    );
  }
  return <div className="flex flex-1 justify-center px-4 py-6 sm:px-8 sm:py-16">{content}</div>;
}

export default VerifySenderPage;
