import { Button, Dialog, Skeleton, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Lock, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { emailIdentityUsagesQuery } from '../api';

import type { EmailIdentityDto } from '@cellhive/contracts';

/** Automations sending as the identity (`GET …/usages`): names only when the caller sees the base. */
function UsageList({
  identity,
  baseNames,
}: {
  readonly identity: EmailIdentityDto;
  readonly baseNames: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation('emailIdentities');
  const usages = useQuery(emailIdentityUsagesQuery(identity.organization_id, identity.id));
  if (usages.isPending) {
    return (
      <div role="status" aria-busy="true" aria-label={t('confirm.loadingUsages')}>
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (usages.isError) return <ErrorAlert error={usages.error} />;
  if (usages.data.total === 0) {
    return <p className="text-body text-fg-muted">{t('confirm.noUsages')}</p>;
  }
  const hidden = usages.data.total - usages.data.items.length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body text-fg">{t('confirm.usages', { count: usages.data.total })}</p>
      <ul
        className="flex max-h-60 flex-col overflow-y-auto rounded-lg border border-line"
        data-testid="identity-usages"
      >
        {usages.data.items.map((usage) => (
          <li
            key={usage.automation_id}
            className="flex items-center gap-2 border-t border-line px-3 py-2 first:border-t-0"
          >
            {usage.name === null ? (
              <>
                <Lock aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
                <span className="text-fg-muted">{t('confirm.hiddenAutomation')}</span>
              </>
            ) : (
              <>
                <Zap aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
                <span className="min-w-0 font-medium break-words">{usage.name}</span>
                <span className="text-label font-normal text-fg-muted">
                  {baseNames.get(usage.base_id) ?? ''}
                </span>
                <Link
                  to={`/b/${encodeURIComponent(usage.base_id)}/automations`}
                  className="ml-auto inline-flex min-h-6 items-center text-label text-accent underline-offset-4 hover:underline max-lg:min-h-control"
                >
                  {t('confirm.open')}
                </Link>
              </>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="text-label font-normal text-fg-muted">
          {t('confirm.moreUsages', { count: hidden })}
        </p>
      ) : null}
    </div>
  );
}

export interface ConfirmIdentityProps {
  readonly kind: 'disable' | 'delete';
  readonly identity: EmailIdentityDto | null;
  readonly baseNames: ReadonlyMap<string, string>;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * Turning off or deleting an identity (board "S5 · Email identities - xác
 * minh": "Tắt danh tính đang được dùng"): the automations sending as it are
 * listed first — they stay on, their email step fails (ADR-33 §1, no
 * fallback to the system sender).
 */
export function ConfirmIdentityDialog({
  kind,
  identity,
  baseNames,
  pending,
  error,
  onConfirm,
  onClose,
}: ConfirmIdentityProps) {
  const { t } = useTranslation('emailIdentities');
  return (
    <Dialog
      open={identity !== null}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={identity === null ? '' : t(`confirm.${kind}Title`, { name: identity.display_name })}
      description={
        identity === null ? undefined : t(`confirm.${kind}Description`, { email: identity.email })
      }
      closeLabel={t('form.close')}
    >
      {identity === null ? null : (
        <div className="flex flex-col gap-4">
          <UsageList identity={identity} baseNames={baseNames} />
          {error === null ? null : <ErrorAlert error={error} />}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('form.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              data-testid="identity-confirm"
              onClick={onConfirm}
            >
              {pending ? <Spinner /> : null}
              {t(`confirm.${kind}`)}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
