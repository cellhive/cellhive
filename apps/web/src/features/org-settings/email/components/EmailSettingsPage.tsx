import { Button, cn, Skeleton, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { AtSign, ChevronRight, Mail, ShieldCheck } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { translateDetail } from '../../../../lib/errors/translate';
import { PAGE_GUTTER, PageHeading } from '../../../../lib/layout/page-heading';
import { notFound } from '../../../../lib/navigation/not-found';
import { meQuery } from '../../../../lib/session/session';
import { showToast } from '../../../../lib/toast/toast';
import { signatureIssue } from '../../email-identities/model/signature';
import { emailSettingsQuery, useUpdateEmailSettings } from '../api';

import { AttachmentsSection } from './AttachmentsSection';
import { FooterPolicySection } from './FooterPolicySection';
import { LimitsSection } from './LimitsSection';
import { SignatureSection } from './SignatureSection';
import { SmtpSection } from './SmtpSection';
import { SystemSenderSection } from './SystemSenderSection';

import type {
  EmailFooterPolicy,
  EmailSettingsDto,
  UpdateEmailSettingsRequest,
} from '@cellhive/contracts';

const SIGNATURE_PATH = 'default_signature_md';

/** The value sent to the API: blank → `null` (the server stores blank as `null` too). */
function signatureValue(source: string): string | null {
  return source.trim() === '' ? null : source;
}

/** Below 1024 px "Save changes" moves to a bar at the bottom, in reach of the signature. */
const WIDE_QUERY = '(min-width: 1024px)';

function subscribeWide(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isWide(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia(WIDE_QUERY).matches;
}

/** The changed keys of the draft, or `null` when nothing changed. */
function changesOf(
  settings: EmailSettingsDto,
  draft: { footer: EmailFooterPolicy | null; signature: string | null },
): UpdateEmailSettingsRequest | null {
  const body: UpdateEmailSettingsRequest = {};
  const automation = settings.automation;
  if (draft.footer !== null && draft.footer !== automation.footer_policy) {
    body.footer_policy = draft.footer;
  }
  if (draft.signature !== null) {
    const next = signatureValue(draft.signature);
    if (next !== automation.default_signature_md) body.default_signature_md = next;
  }
  return Object.keys(body).length === 0 ? null : body;
}

function LoadingSections() {
  const { t } = useTranslation('emailSettings');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('loading')}
      className="flex flex-col gap-4"
      data-testid="email-settings-loading"
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5"
        >
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <Skeleton className="h-16" />
        </div>
      ))}
    </div>
  );
}

/** Side cards: the way to sender identities (T533) and who sees the page. */
function Aside({ orgSlug }: { readonly orgSlug: string }) {
  const { t } = useTranslation('emailSettings');
  return (
    <aside className="flex min-w-0 flex-col gap-4 lg:w-72 lg:shrink-0">
      <section
        aria-labelledby="email-identities-title"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="email-identities-title" className="flex items-center gap-2 text-heading">
          <AtSign aria-hidden="true" className="size-4 text-accent" />
          {t('identities.title')}
        </h2>
        <p className="text-label font-normal text-fg-muted">{t('identities.description')}</p>
        <Button variant="secondary" asChild className="w-fit max-lg:h-control">
          <Link
            to={`/o/${encodeURIComponent(orgSlug)}/settings/email/identities`}
            data-testid="manage-identities"
          >
            {t('identities.manage')}
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </section>
      <section
        aria-labelledby="email-audience-title"
        className="flex flex-col gap-1 rounded-lg border border-line bg-surface-sunken p-4"
      >
        <h2 id="email-audience-title" className="flex items-center gap-2 text-body font-semibold">
          <ShieldCheck aria-hidden="true" className="size-4 text-fg-muted" />
          {t('audience.title')}
        </h2>
        <p className="text-label font-normal text-fg-muted">{t('audience.body')}</p>
      </section>
    </aside>
  );
}

/**
 * `/o/:orgSlug/settings/email` (T526, FRONTEND §15; board "S5 · Admin email
 * settings"): organization owners/admins (route guard `orgSettings`, others
 * the 404 screen). Instance SMTP read-only + "Test connection", limits in
 * force, then the automation email settings of the organization (CONTRACTS
 * §23.4): footer policy and default signature are a draft saved with "Save
 * changes"; the system sender switch applies at once (confirmation first
 * when automations use it); attachment limits (T532) have their own
 * "Save". No form edits the SMTP server (organization
 * SMTP is P1).
 */
export function EmailSettingsPage() {
  const { t } = useTranslation('emailSettings');
  const { i18n } = useTranslation();
  const { orgSlug } = useParams();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.slug === orgSlug);
  const orgId = org?.id ?? '';
  const settings = useQuery({ ...emailSettingsQuery(orgId), enabled: org !== undefined });
  const save = useUpdateEmailSettings(orgId);
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  const [footer, setFooter] = useState<EmailFooterPolicy | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  useDocumentTitle(org === undefined ? undefined : `${t('title')} · ${org.name}`);
  if (me.data !== undefined && org === undefined) notFound();
  if (org === undefined || me.data === undefined || me.data === null) return null;

  const data = settings.data;
  const changes = data === undefined ? null : changesOf(data, { footer, signature });
  const signatureText = signature ?? data?.automation.default_signature_md ?? '';
  const invalid = signature !== null && signatureIssue(signature) !== null;
  const serverSignatureError =
    save.error !== null && isApiError(save.error)
      ? (save.error.errors.find((item) => item.path === SIGNATURE_PATH) ?? null)
      : null;
  const reset = () => {
    setFooter(null);
    setSignature(null);
    save.reset();
  };
  const submit = () => {
    if (changes === null || invalid) return;
    save.mutate(changes, {
      onSuccess: () => {
        setFooter(null);
        setSignature(null);
        showToast({ variant: 'success', message: t('saved') });
      },
    });
  };
  const dirty = changes !== null;
  const actions = (
    <>
      <Button
        variant="ghost"
        disabled={!dirty || save.isPending}
        onClick={reset}
        data-testid="email-settings-cancel"
      >
        {t('cancel')}
      </Button>
      <Button
        disabled={!dirty || invalid || save.isPending}
        onClick={submit}
        data-testid="email-settings-save"
      >
        {save.isPending ? <Spinner /> : null}
        {t('save')}
      </Button>
    </>
  );

  return (
    <div className={cn('flex min-h-full flex-col bg-canvas', dirty && !wide && 'pb-20')}>
      <PageHeading
        back={{
          to: `/o/${encodeURIComponent(org.slug)}`,
          label: t('back', { name: org.name }),
        }}
        icon={Mail}
        title={t('title')}
        subtitle={t('subtitle', { org: org.name })}
        actions={data === undefined || !wide ? undefined : actions}
      />
      <div
        className={cn(
          'flex w-full max-w-[1120px] flex-col gap-6 py-6 lg:flex-row lg:items-start',
          PAGE_GUTTER,
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {settings.error !== null ? (
            <ErrorAlert error={settings.error} />
          ) : data === undefined ? (
            <LoadingSections />
          ) : (
            <>
              <SmtpSection
                orgId={org.id}
                settings={data}
                email={me.data.user.email}
                timeZone={me.data.timezone}
              />
              <LimitsSection settings={data} timeZone={me.data.timezone} />
              <FooterPolicySection
                automation={data.automation}
                value={footer ?? data.automation.footer_policy}
                orgName={org.name}
                onChange={setFooter}
              />
              <SignatureSection
                orgId={org.id}
                value={signatureText}
                onChange={setSignature}
                serverError={
                  serverSignatureError === null
                    ? undefined
                    : translateDetail(i18n, serverSignatureError)
                }
              />
              {save.error !== null && serverSignatureError === null ? (
                <ErrorAlert error={save.error} />
              ) : null}
              <SystemSenderSection orgId={org.id} settings={data} />
              <AttachmentsSection orgId={org.id} settings={data} />
            </>
          )}
        </div>
        <Aside orgSlug={org.slug} />
      </div>
      {dirty && !wide ? (
        <div
          data-testid="email-settings-bar"
          className="fixed inset-x-0 bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-4 py-3 shadow-popover"
        >
          <span className="mr-auto text-label font-normal text-fg-muted">{t('unsaved')}</span>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export default EmailSettingsPage;
