import { PUBLIC_SHARING_POLICIES, type PublicSharingPolicy } from '@cellhive/contracts';
import { Alert, Button, Skeleton, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { orgQuery } from '../../../../lib/query/queries';
import { showToast } from '../../../../lib/toast/toast';
import { shareLinkListQuery, useSetPublicSharing } from '../api';
import { blockedLinkFilters } from '../policy';

/**
 * `organizations.settings.public_sharing` (CONTRACTS §16) for owners/admins:
 * allowed / forms only / disabled. Before saving a stricter policy the form
 * shows how many enabled public links it blocks (they are kept, `blocked`,
 * and work again when allowed).
 */
export function PublicSharingPolicyForm({ orgId }: { orgId: string }) {
  const { t } = useTranslation('share');
  const titleId = useId();
  const name = useId();
  const org = useQuery({ ...orgQuery(orgId), staleTime: 0 });
  const current = org.data?.settings.public_sharing;
  const [choice, setChoice] = useState<PublicSharingPolicy | null>(null);
  const selected = choice ?? current;
  const save = useSetPublicSharing(orgId);
  const changed = selected !== undefined && selected !== current;
  const impactFilters = changed ? blockedLinkFilters(selected) : null;
  const counted = useQuery({
    ...shareLinkListQuery(
      { kind: 'org', orgId },
      { ...(impactFilters?.count ?? {}), offset: 0, limit: 1 },
    ),
    enabled: impactFilters !== null,
  });
  // Forms only: public forms stay open (T814: dashboards are blocked like views).
  const kept = useQuery({
    ...shareLinkListQuery(
      { kind: 'org', orgId },
      { ...(impactFilters?.minus ?? {}), offset: 0, limit: 1 },
    ),
    enabled: impactFilters?.minus !== undefined,
  });
  const impact = {
    isPending: counted.isPending || (impactFilters?.minus !== undefined && kept.isPending),
    isError: counted.isError || kept.isError,
    error: counted.error ?? kept.error,
    total:
      counted.data === undefined
        ? undefined
        : counted.data.total - (impactFilters?.minus === undefined ? 0 : (kept.data?.total ?? 0)),
  };

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-heading">
          {t('policy.title')}
        </h2>
        <p className="text-fg-muted">{t('policy.description')}</p>
      </div>
      {org.isPending ? (
        <Skeleton className="h-24" />
      ) : org.isError ? (
        <ErrorAlert error={org.error} />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!changed) return;
            save.mutate(selected, {
              onSuccess: () => {
                setChoice(null);
                showToast({ variant: 'success', message: t('policy.saved') });
              },
            });
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('policy.legend')}</legend>
            {PUBLIC_SHARING_POLICIES.map((policy) => (
              <PolicyOption
                key={policy}
                name={name}
                policy={policy}
                checked={selected === policy}
                onSelect={() => {
                  setChoice(policy);
                }}
              />
            ))}
          </fieldset>
          {changed ? (
            <Alert variant={impact.total !== undefined && impact.total > 0 ? 'danger' : 'info'}>
              {impactFilters === null
                ? t('policy.impactNone')
                : impact.isPending
                  ? t('policy.impactLoading')
                  : impact.isError || impact.total === undefined
                    ? null
                    : impact.total === 0
                      ? t('policy.impactNone')
                      : t('policy.impact', { count: impact.total })}
            </Alert>
          ) : null}
          {impact.error === null ? null : <ErrorAlert error={impact.error} />}
          {save.isError ? <ErrorAlert error={save.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!changed || save.isPending}>
              {save.isPending ? <Spinner /> : null}
              {t('policy.save')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function PolicyOption({
  name,
  policy,
  checked,
  onSelect,
}: {
  name: string;
  policy: PublicSharingPolicy;
  checked: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('share');
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="radio"
        name={name}
        value={policy}
        checked={checked}
        aria-describedby={`${id}-hint`}
        onChange={onSelect}
        className="mt-0.5 size-4 shrink-0 accent-accent"
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-body text-fg">
          {t(`policy.${policy}`)}
        </label>
        <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
          {t(`policy.${policy}Hint`)}
        </p>
      </div>
    </div>
  );
}
