import {
  SHARE_FORM_MAX_FILES_PER_QUESTION,
  SHARE_FORM_MAX_UPLOAD_BYTES,
} from '@cellhive/contracts';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { keys } from '../../../../lib/query/keys';

import { ShareLoading } from './ShareScreens';

import type {
  FormAntiSpam,
  FormLinkSource,
  FormMember,
  FormRendererComponent,
  FormUploadSource,
} from '../../../../lib/forms/renderer';
import type { ShareApi } from '../api';
import type { FormSubmitRequest, Id, ShareMeta, StoredFormSettings } from '@cellhive/contracts';
import type { LocaleContext } from '@cellhive/field-types';

const EMPTY_FORM: StoredFormSettings = {
  title: '',
  description: '',
  cover_attachment_id: null,
  fields: [],
  success_message: '',
  redirect_url: null,
  allow_multiple_submissions: true,
  require_login: false,
  submission_limit: 'none',
};

export interface SharedFormProps {
  readonly meta: ShareMeta;
  readonly api: ShareApi;
  readonly FormRenderer: FormRendererComponent;
  readonly locale: LocaleContext;
  /** A request that ends the page (`401` → sign in, link gone…), like the other share screens. */
  readonly onFatal?: ((error: unknown) => void) | undefined;
}

/**
 * The public form of a form link (T317, F§6.7): the `FormRenderer` of T315
 * posting to `POST /shares/:token/submit` with its anti-spam (a submit
 * token fetched when the form opens, the minimum fill time, the honeypot;
 * CONTRACTS §17). `?prefill_<field_id>=…&hide_<field_id>=1` prefills.
 *
 * T321: people questions only reach this page on `org` links (a public
 * link's `meta` leaves them out); their choices come from `GET
 * /shares/:token/members` (`{ id, display_name }`, no email). A form that
 * requires sign-in and has a submission limit asks `GET
 * /shares/:token/submission-status` first and opens on the limit screen when
 * the person already reached it.
 *
 * T410: link questions only reach this page on `org` links too; their
 * records come from `GET /shares/:token/link-candidates/:fieldId` (`{ id,
 * title }`). Files of attachment questions are uploaded through `POST
 * /shares/:token/uploads`, bound to the submit token the form is sent with
 * (at most 10 per question, CONTRACTS §17).
 */
export function SharedForm({ meta, api, FormRenderer, locale, onFatal }: SharedFormProps) {
  const { t } = useTranslation('form');
  const form = meta.view.config.form ?? EMPTY_FORM;
  useDocumentTitle(form.title.trim() === '' ? t('fill.untitled') : form.title);
  const { search } = useLocation();
  const antiSpam = useMemo<FormAntiSpam>(
    () => ({ fetchToken: (signal) => api.submitToken(signal) }),
    [api],
  );
  const submit = useCallback((body: FormSubmitRequest) => api.submit(body), [api]);
  const links = useMemo<FormLinkSource>(
    () => ({
      search: async (fieldId, query, signal) => {
        const inputs = await import('../form-inputs-api');
        const page = await inputs.linkCandidates(api, fieldId, query, signal);
        return { items: page.items, hasMore: page.has_more };
      },
    }),
    [api],
  );
  const uploads = useMemo<FormUploadSource>(
    () => ({
      start: async (body, submitToken, signal) => {
        const inputs = await import('../form-inputs-api');
        return inputs.createUpload(
          api,
          {
            ...body,
            field_id: body.field_id as Id<'fld'>,
            ...(submitToken === null ? {} : { submit_token: submitToken }),
          },
          signal,
        );
      },
      complete: async (attachmentId, submitToken, signal) => {
        const inputs = await import('../form-inputs-api');
        return inputs.completeUpload(api, attachmentId, submitToken ?? undefined, signal);
      },
      maxFilesPerQuestion: SHARE_FORM_MAX_FILES_PER_QUESTION,
      maxTotalBytes: SHARE_FORM_MAX_UPLOAD_BYTES,
    }),
    [api],
  );
  // The cover through the link (T419): only the one the form names is served.
  const coverUrlOf = useCallback((id: string) => api.formCoverUrl(id), [api]);

  const needsMembers = form.fields.some(
    (item) => meta.fields.find((field) => field.id === item.field)?.type === 'user',
  );
  const members = useQuery({
    queryKey: keys.shareFormMembers(api.token),
    queryFn: ({ signal }) => api.members(signal),
    enabled: needsMembers,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const memberOptions = useMemo<FormMember[] | undefined>(
    () =>
      members.data?.items.map((member) => ({
        id: member.id,
        name: member.display_name,
        email: null,
      })),
    [members.data],
  );

  // A limit already reached shows at once, not after filling the form in.
  const limited = form.require_login && form.submission_limit !== 'none';
  const status = useQuery({
    queryKey: keys.shareSubmissionStatus(api.token),
    queryFn: ({ signal }) => api.submissionStatus(signal),
    enabled: limited,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const failure = status.error;
  useEffect(() => {
    // Sign-in needed, link gone…: the page's screens. Other failures leave the form
    // open (submitting checks again); without members, people questions say so.
    if (failure !== null) onFatal?.(failure);
  }, [failure, onFatal]);

  if (limited && status.isPending) {
    return (
      <main className="flex-1 bg-canvas">
        <p role="status" className="mx-auto mt-8 w-full max-w-2xl px-4 text-fg-muted sm:px-0">
          {t('page.checkingLimit')}
        </p>
      </main>
    );
  }
  // Prefilled people are matched against the list: wait for it.
  if (needsMembers && members.isPending) return <ShareLoading />;
  const reached =
    limited && status.data?.reached === true
      ? { nextAllowedAt: status.data.next_allowed_at }
      : null;
  return (
    <main className="flex-1 bg-canvas">
      <FormRenderer
        key={reached === null ? 'open' : 'limit'}
        form={form}
        fields={meta.fields}
        locale={locale}
        search={search}
        submit={submit}
        antiSpam={antiSpam}
        members={memberOptions}
        links={links}
        uploads={uploads}
        limitReached={reached}
        headingLevel={1}
        coverUrlOf={coverUrlOf}
      />
    </main>
  );
}
