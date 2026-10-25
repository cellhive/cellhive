import {
  DEFAULT_EMAIL_MAX_INLINE_IMAGES,
  EMAIL_FOOTER_LEVELS,
  MAX_TEMPLATE_LENGTH,
  type AutomationAction,
  type AutomationDefinition,
  type SendEmailConfig,
} from '@cellhive/contracts';
import { Button, Select, Switch } from '@cellhive/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { api } from '../../../../../lib/api';
import { canDownloadFile } from '../../../../../lib/permissions/access';
import { isOrgAdmin } from '../../../../../lib/permissions/org';
import { orgQuery } from '../../../../../lib/query/queries';
import { meQuery } from '../../../../../lib/session/session';
import { MarkdownTemplateEditor } from '../../../template-editor/MarkdownTemplateEditor';
import { useBuilderEnv } from '../../components/env';
import {
  IssueText,
  Note,
  PanelField,
  Segmented,
  useIssuesAt,
} from '../../components/panels/common';
import { ExpressionDialog } from '../../components/values/ExpressionDialog';
import { pickerSections } from '../../components/values/sections';
import { TemplateInput } from '../../components/values/TemplateInput';
import { useTemplateChips } from '../../components/values/use-template-chips';
import { hasTriggerRecord } from '../../model/draft';
import { issuesOf, type StepKey } from '../../model/issues';

import { AttachmentsSection } from './AttachmentsSection';
import { DIGEST_EXPRESSION, DigestSettings } from './DigestSettings';
import { EmailPreviewPane, type SampleRecord } from './EmailPreviewPane';
import { EmailImageContext, type EmailImageOptions } from './image-context';
import { EmailImageButton } from './image-hook';
import { bodyImageCount, emailImageFields } from './images';
import {
  effectiveFooter,
  emailLimitsOf,
  footerLock,
  readableAddress,
  replyToKey,
  replyToOf,
  senderKeyOf,
  senderOptions,
  USER_FIELD_TYPES,
} from './model';
import { baseEmailIdentitiesQuery, builderEmailSettingsQuery } from './queries';
import { RecipientsField } from './RecipientsField';
import { SenderPicker } from './SenderPicker';
import { previewable, useEmailPreview, useSettled } from './use-email-preview';

import type { ValueScope } from '../../model/scope';

const PATH_CONFIG_FOOTER = 'config.footer';
const PATH_CONFIG_SUBJECT_TEMPLATE = 'config.subject.template';
const TEST_EMAIL_BODY = 'email-body';
const TEST_EMAIL_SUBJECT = 'email-subject';
const TEST_FOOTER_TIGHTENED = 'footer-tightened';
const TEST_MAY_NOT_READ = 'may-not-read';
const TEST_SENDER_MISSING = 'sender-missing';
const TEST_SENDER_NONE = 'sender-none';
const TEST_SMTP_MISSING = 'smtp-missing';

type SendEmailAction = Extract<AutomationAction, { type: 'send_email' }>;

export interface SendEmailEditorProps {
  readonly action: SendEmailAction;
  /** "2.1" */
  readonly number: string;
  readonly definition: AutomationDefinition;
  readonly scope: ValueScope;
  /** The saved automation (`null` until created: no preview nor test yet). */
  readonly automationId: string | null;
  readonly onChange: (action: AutomationAction) => void;
  /** Back to the flow ("Sơ đồ"). */
  readonly onClose: () => void;
}

const SAMPLE_RECORDS = 50;

/**
 * The wide editor of a `send_email` step (T522; Quyết định S5 thiết kế #2;
 * boards "S5 · Email template editor", "… - tab và lỗi"): settings on the
 * left (sender with "recipients will see", To/Cc/Bcc, Reply-To, subject,
 * Markdown body, signature, footer, attachments), the preview of the
 * server on the right (sample record, HTML/Text/Headers, test send,
 * checks). It replaces the flow and the 440 px panel while open; "Flow"
 * or Escape goes back to the card.
 */
export default function SendEmailEditor({
  action,
  number,
  definition,
  scope,
  automationId,
  onChange,
  onClose,
}: SendEmailEditorProps) {
  const { t } = useTranslation(['automationEmail', 'automationBuilder']);
  const { t: tb } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const step = action.id as StepKey;
  const config = action.config;
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    heading.current?.focus();
  }, [action.id]);

  const me = useQuery(meQuery());
  const org = useQuery(orgQuery(env.orgId));
  const orgRole = me.data?.orgs.find((item) => item.id === env.orgId)?.role;
  const orgAdmin = isOrgAdmin(orgRole);
  const orgSlug = me.data?.orgs.find((item) => item.id === env.orgId)?.slug ?? null;
  const settings = useQuery(builderEmailSettingsQuery(env.orgId, orgAdmin));
  const identities = useQuery(baseEmailIdentitiesQuery(env.base.id));
  const orgLocale = org.data?.settings.locale ?? null;
  const [smtpMissingSeen, setSmtpMissingSeen] = useState(false);

  const set = (patch: Partial<SendEmailConfig>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };

  // --- Sender ---------------------------------------------------------------------
  const options = useMemo(
    () =>
      senderOptions(identities.data?.items ?? [], {
        systemSenderEnabled: settings.data?.automation.system_sender_enabled ?? null,
        smtpFrom: settings.data?.smtp.from ?? null,
        orgName: org.data?.name ?? '',
      }),
    [identities.data, settings.data, org.data],
  );
  const current = options.find((option) => option.key === senderKeyOf(config.identity_id));
  const senderMissing = identities.isSuccess && current === undefined;
  const lock = footerLock(
    current?.mode ?? (config.identity_id === null ? 'system' : null),
    settings.data?.automation.footer_none_allowed ?? null,
  );

  // --- Preview -----------------------------------------------------------------------
  const tableId = hasTriggerRecord(definition.trigger) ? scope.triggerTableId : null;
  const primary = env.tables.find((table) => table.id === tableId)?.primary_field_id ?? null;
  const [recordSearch, setRecordSearch] = useState('');
  const search = useSettled(recordSearch.trim(), 300);
  const sample = useQuery({
    queryKey: ['table', tableId ?? '', 'email-preview-records', primary, search] as const,
    enabled: tableId !== null,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.records.query(
        tableId ?? '',
        {
          fields: primary === null ? [] : [primary],
          limit: SAMPLE_RECORDS,
          include_total: false,
          ...(search === '' ? {} : { search }),
        },
        { signal, cellFormat: 'text' },
      ),
  });
  const records: SampleRecord[] | null =
    tableId === null
      ? null
      : (sample.data?.records ?? []).map((record) => {
          const value = primary === null ? '' : record.fields[primary];
          return { id: record.id, title: typeof value === 'string' ? value : '' };
        });
  const [chosenRecord, setChosenRecord] = useState<string | null>(null);
  const recordId =
    tableId === null
      ? null
      : records?.some((record) => record.id === chosenRecord) === true
        ? chosenRecord
        : (records?.[0]?.id ?? null);
  const waitingForRecord = tableId !== null && recordId === null;
  const preview = useEmailPreview({
    automationId,
    actionId: action.id,
    config,
    recordId,
    waitingForRecord,
  });
  const blocked =
    automationId === null
      ? 'not_saved'
      : !previewable(config)
        ? 'incomplete'
        : tableId !== null && !sample.isPending && search === '' && (records?.length ?? 0) === 0
          ? 'no_records'
          : null;
  const limits = emailLimitsOf(settings.data, preview.data);
  // "Recipients see" of the chosen sender from the server, once the preview is of that sender.
  const previewSender =
    preview.data === undefined || preview.data.identity_id !== config.identity_id
      ? null
      : {
          from: readableAddress(preview.data.headers.from),
          replyTo:
            preview.data.headers.reply_to === null
              ? null
              : readableAddress(preview.data.headers.reply_to),
        };
  const recordTitle = records?.find((record) => record.id === recordId)?.title ?? null;
  const smtpMissing =
    smtpMissingSeen || (settings.data !== undefined && !settings.data.smtp.configured);

  // --- Templates ---------------------------------------------------------------------
  const sections = pickerSections({
    scope,
    names: env,
    tableName: env.tableName,
    mode: 'template',
    t: tb,
  });
  const subjectChips = useTemplateChips(config.subject.template, scope);
  const bodyChipsBase = useTemplateChips(config.body.template, scope);
  const bodyChips = (expression: string, index: number) =>
    expression === DIGEST_EXPRESSION
      ? { text: t('digest.chip'), tone: 'step' as const }
      : bodyChipsBase(expression, index);
  const [expression, setExpression] = useState<((stored: string) => void) | null>(null);
  const bodyIssues = useIssuesAt(step, 'config.body.template');
  const fieldName = (fieldId: string) =>
    tableId === null
      ? null
      : (env.fieldsOf(tableId)?.find((field) => field.id === fieldId)?.name ?? null);
  const generalIssues = issuesOf(env.issues, step).filter((issue) => issue.path === '');
  const imageFields = useMemo(
    () =>
      tableId === null
        ? []
        : emailImageFields(env.fieldsOf(tableId) ?? [], (fieldId) =>
            canDownloadFile(env.base.access, tableId, fieldId),
          ),
    [env, tableId],
  );
  const imageCount = useMemo(() => bodyImageCount(config.body.template), [config.body.template]);
  const maxImages = settings.data?.limits.max_inline_images ?? DEFAULT_EMAIL_MAX_INLINE_IMAGES;
  const imageOptions = useMemo<EmailImageOptions>(
    () => ({ automationId, fields: imageFields, count: imageCount, max: maxImages }),
    [automationId, imageFields, imageCount, maxImages],
  );
  const senderIssues = useIssuesAt(step, 'config.identity_id');

  // --- Reply-To ----------------------------------------------------------------------
  const userFields =
    tableId === null
      ? []
      : (env.fieldsOf(tableId) ?? []).filter((field) => USER_FIELD_TYPES.has(field.type));
  const replyKey = replyToKey(config.reply_to);
  const replyOptions: { key: string; label: string }[] = [
    { key: 'default', label: t('replyTo.default') },
    ...(identities.data?.items ?? []).map((identity) => ({
      key: `identity:${identity.id}`,
      label: t('replyTo.identity', { name: identity.display_name, email: identity.email }),
    })),
    ...userFields.map((field) => ({
      key: `field:${field.id}`,
      label: t('replyTo.field', { name: field.name }),
    })),
    ...(definition.trigger.type === 'button.clicked'
      ? [{ key: 'clicked_by', label: t('replyTo.clickedBy') }]
      : []),
    { key: 'run_as', label: t('replyTo.runAs') },
  ];

  const recipients = (key: 'to' | 'cc' | 'bcc', label: string) => (
    <RecipientsField
      label={label}
      step={step}
      path={`config.${key}`}
      value={config[key]}
      onChange={(next) => {
        set({ [key]: next });
      }}
      scope={scope}
      testId={`email-${key}`}
    />
  );

  const signatureOwner =
    current === undefined || current.mode === 'system'
      ? t('signature.org')
      : t('signature.identity', { name: current.name });

  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden"
        data-testid="email-editor"
        onKeyDown={(event) => {
          // Menus and dialogs live in portals: their Escape is theirs.
          const inside = event.currentTarget.contains(event.target as Node);
          if (event.key === 'Escape' && !event.defaultPrevented && inside) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <section
          aria-labelledby={`${id}-title`}
          className="flex shrink-0 flex-col gap-4 border-line bg-surface px-4 pt-4 pb-6 sm:px-6 xl:w-[680px] xl:overflow-y-auto xl:border-r"
        >
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="-ml-2 max-lg:h-control" onClick={onClose}>
              <ChevronLeft aria-hidden="true" />
              {t('editor.flow')}
            </Button>
            <span aria-hidden="true" className="text-fg-subtle">
              /
            </span>
            <h2
              id={`${id}-title`}
              ref={heading}
              tabIndex={-1}
              className="min-w-0 truncate text-heading outline-none"
            >
              {tb('panel.step', { number, type: tb('actionType.send_email') })}
            </h2>
          </div>
          <IssueText id={`${id}-issues`} issues={generalIssues} />
          {smtpMissing ? (
            <Note tone="danger" title={t('smtp.title')} testId={TEST_SMTP_MISSING}>
              {t('smtp.body')}{' '}
              {orgAdmin && orgSlug !== null ? (
                <Link className="text-accent underline" to={`/o/${orgSlug}/settings/email`}>
                  {t('smtp.open')}
                </Link>
              ) : null}
            </Note>
          ) : null}

          <div className="flex flex-col gap-1.5">
            {options.length === 0 && identities.isSuccess ? (
              <Note tone="warning" title={t('sender.label')} testId={TEST_SENDER_NONE}>
                {t('sender.none')}
              </Note>
            ) : (
              <SenderPicker
                options={options}
                value={config.identity_id}
                onChange={(identityId) => {
                  set({ identity_id: identityId });
                }}
                smtpFrom={settings.data?.smtp.from ?? null}
                orgLocale={orgLocale}
                previewFrom={previewSender?.from ?? null}
                previewReplyTo={previewSender?.replyTo ?? null}
                describedBy={senderIssues.length > 0 ? `${id}-sender-issues` : undefined}
              />
            )}
            {senderMissing ? (
              <Note tone="warning" testId={TEST_SENDER_MISSING}>
                {config.identity_id === null ? t('sender.systemOff') : t('sender.missing')}
              </Note>
            ) : null}
            <IssueText id={`${id}-sender-issues`} issues={senderIssues} />
          </div>

          <div className="flex flex-col gap-2" role="group" aria-label={t('recipients.title')}>
            {recipients('to', t('recipients.to'))}
            {recipients('cc', t('recipients.cc'))}
            {recipients('bcc', t('recipients.bcc'))}
            <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2 max-sm:grid-cols-1">
              <label htmlFor={`${id}-reply`} className="pt-2 text-label text-fg">
                {t('replyTo.label')}
              </label>
              <div className="flex min-w-0 flex-col gap-1">
                <Select
                  id={`${id}-reply`}
                  value={replyKey}
                  aria-describedby={`${id}-reply-hint`}
                  data-testid="email-reply-to"
                  onChange={(event) => {
                    set({ reply_to: replyToOf(event.target.value) });
                  }}
                >
                  {replyOptions.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                  {replyOptions.some((option) => option.key === replyKey) ? null : (
                    <option value={replyKey}>{t('replyTo.unknown')}</option>
                  )}
                </Select>
                <p id={`${id}-reply-hint`} className="text-label font-normal text-fg-muted">
                  {t('replyTo.hint')}
                </p>
                <IssueText
                  id={`${id}-reply-issues`}
                  issues={issuesOf(env.issues, step).filter((issue) =>
                    issue.path.startsWith('config.reply_to'),
                  )}
                />
              </div>
            </div>
          </div>

          {preview.data?.warnings.some((warning) => warning.code === 'RECIPIENT_MAY_NOT_READ') ===
          true ? (
            <Note tone="warning" title={t('mayNotRead.title')} testId={TEST_MAY_NOT_READ}>
              {t('mayNotRead.body')}
            </Note>
          ) : null}

          <PanelField
            label={t('subject.label')}
            step={step}
            path={PATH_CONFIG_SUBJECT_TEMPLATE}
            hint={t('subject.hint')}
          >
            {(control) => (
              <TemplateInput
                value={config.subject.template}
                onChange={(template) => {
                  set({ subject: { template: template.replace(/[\r\n]+/gu, ' ') } });
                }}
                chipLabel={subjectChips}
                sections={sections}
                onExpression={(insert) => {
                  setExpression(() => insert);
                }}
                label={t('subject.label')}
                invalid={control['aria-invalid']}
                describedBy={control['aria-describedby']}
                testId={TEST_EMAIL_SUBJECT}
              />
            )}
          </PanelField>

          <div className="flex flex-col gap-1.5">
            <span id={`${id}-body`} className="text-label text-fg">
              {t('body.label')}
            </span>
            <EmailImageContext.Provider value={imageOptions}>
              <MarkdownTemplateEditor
                value={config.body.template}
                onChange={(template) => {
                  set({ body: { ...config.body, template } });
                }}
                chipLabel={bodyChips}
                sections={sections}
                labelId={`${id}-body`}
                label={t('body.label')}
                invalid={bodyIssues.length > 0}
                describedBy={bodyIssues.length > 0 ? `${id}-body-issues` : undefined}
                testId={TEST_EMAIL_BODY}
                maxLength={MAX_TEMPLATE_LENGTH}
                onExpression={(insert) => {
                  setExpression(() => insert);
                }}
                ImageButton={EmailImageButton}
              />
            </EmailImageContext.Provider>
            <IssueText id={`${id}-body-issues`} issues={bodyIssues} />
            <DigestSettings
              actionId={action.id}
              definition={definition}
              body={config.body}
              onChange={(body) => {
                set({ body });
              }}
              scope={scope}
            />
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-md:grid-cols-1">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Switch
                  id={`${id}-signature`}
                  checked={config.include_signature}
                  aria-describedby={`${id}-signature-hint`}
                  data-testid="email-signature"
                  onChange={(event) => {
                    set({ include_signature: event.target.checked });
                  }}
                />
                <label htmlFor={`${id}-signature`} className="text-body">
                  {t('signature.label')}
                </label>
              </div>
              <p id={`${id}-signature-hint`} className="text-label font-normal text-fg-muted">
                {signatureOwner}
              </p>
            </div>
            <PanelField
              label={t('footer.label')}
              step={step}
              path={PATH_CONFIG_FOOTER}
              hint={t(`footer.lock.${lock ?? (settings.data === undefined ? 'unknown' : 'none')}`)}
              group
            >
              {() => (
                <Segmented
                  label={t('footer.label')}
                  value={config.footer}
                  name={`${id}-footer`}
                  options={EMAIL_FOOTER_LEVELS.map((level) => ({
                    value: level,
                    label: t(`footer.levels.${level}`),
                    disabled: level === 'none' && lock !== null,
                  }))}
                  onChange={(footer) => {
                    set({ footer });
                  }}
                />
              )}
            </PanelField>
          </div>
          {config.footer !== effectiveFooter(config.footer, lock) ? (
            <Note tone="warning" title={t('footer.tightenedTitle')} testId={TEST_FOOTER_TIGHTENED}>
              {t('footer.tightenedBody')}
            </Note>
          ) : null}

          <AttachmentsSection
            step={step}
            config={config}
            onChange={(patch) => {
              set(patch);
            }}
            tableId={tableId}
            preview={preview.data}
            recordTitle={recordTitle}
            limits={limits}
          />
        </section>

        <EmailPreviewPane
          automationId={automationId}
          actionId={action.id}
          config={config}
          preview={preview}
          blocked={blocked}
          records={records}
          recordsLoading={sample.isPending && tableId !== null}
          recordId={recordId}
          onRecord={setChosenRecord}
          recordSearch={recordSearch}
          onRecordSearch={setRecordSearch}
          limits={limits}
          orgLocale={orgLocale}
          meEmail={me.data?.user.email ?? null}
          fieldName={fieldName}
          onSmtpMissing={() => {
            setSmtpMissingSeen(true);
          }}
        />
      </div>
      {expression === null ? null : (
        <ExpressionDialog
          baseId={env.base.id}
          scope={scope}
          onCancel={() => {
            setExpression(null);
          }}
          onInsert={(stored) => {
            expression(stored);
            setExpression(null);
          }}
        />
      )}
    </>
  );
}
