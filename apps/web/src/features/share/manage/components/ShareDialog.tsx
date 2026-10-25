import {
  SHARE_LINK_PASSWORD_MIN_LENGTH,
  type BaseDetail,
  type CreatedShareLinkDto,
  type DashboardDto,
  type PublicSharingPolicy,
  type ShareLinkDto,
  type ShareLinkTargetType,
  type ViewDto,
} from '@cellhive/contracts';
import {
  Alert,
  Button,
  cn,
  Dialog,
  FormField,
  Input,
  Select,
  Skeleton,
  Spinner,
} from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Copy, Power, PowerOff, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { canDownload, canDownloadFile, isBaseAdmin } from '../../../../lib/permissions/access';
import { fieldsQuery, orgQuery } from '../../../../lib/query/queries';
import { meQuery } from '../../../../lib/session/session';
import { showToast } from '../../../../lib/toast/toast';
import {
  shareLinkPreviewQuery,
  targetShareLinksQuery,
  useCreateShareLink,
  useRegenerateShareLink,
  useRevokeShareLink,
  useUpdateShareLink,
  type ShareContext,
} from '../api';
import {
  createBody,
  flagOf,
  flagPatch,
  hasErrors,
  initialDraft,
  linkFileFields,
  REFRESH_CHOICES,
  settingKeys,
  updateBody,
  validateDraft,
  widensAudience,
  type FlagSetting,
  type ShareDraft,
} from '../draft';
import { maskedUrl, publicBlockedBy, targetTypeOf } from '../policy';
import { accessSummary } from '../stats';

import { EmbedPanel } from './EmbedPanel';
import { DashboardScopeWarning, ScopeWarning } from './ScopeWarning';
import { ShareOption } from './ShareOption';
import { StatusBadge } from './StatusBadge';

/** What the dialog shares: a view (grid, kanban, form) or (T814) a dashboard. */
export type ShareTarget =
  | { readonly kind: 'view'; readonly view: ViewDto }
  | {
      readonly kind: 'dashboard';
      readonly dashboard: Pick<DashboardDto, 'id' | 'name' | 'widgets'>;
    };

export interface ShareDialogProps {
  readonly target: ShareTarget;
  readonly base: BaseDetail;
  readonly onClose: () => void;
}

/** A token returned by create/regenerate: kept only in this dialog's memory, shown once. */
interface Revealed {
  readonly linkId: string;
  readonly url: string;
}

/** Labels and hints of the on/off settings (dashboard CSV has its own words). */
const SETTING_TEXT: Record<FlagSetting, { readonly label: string; readonly hint: string }> = {
  allow_copy: { label: 'settings.allowCopy', hint: 'settings.allowCopyHint' },
  allow_download: { label: 'settings.allowDownload', hint: 'settings.allowDownloadHint' },
  allow_export: { label: 'settings.allowExport', hint: 'settings.allowExportHint' },
  allow_search: { label: 'settings.allowSearch', hint: 'settings.allowSearchHint' },
  allow_viewer_filter_sort: {
    label: 'settings.allowViewerFilterSort',
    hint: 'settings.allowViewerFilterSortHint',
  },
  show_record_detail: { label: 'settings.showRecordDetail', hint: 'settings.showRecordDetailHint' },
  allow_filter_controls: {
    label: 'settings.allowFilterControls',
    hint: 'settings.allowFilterControlsHint',
  },
  tv_mode: { label: 'settings.tvMode', hint: 'settings.tvModeHint' },
};

function settingText(key: FlagSetting, targetType: ShareLinkTargetType) {
  if (key === 'allow_export' && targetType === 'dashboard') {
    return { label: 'settings.allowExportDashboard', hint: 'settings.allowExportDashboardHint' };
  }
  return SETTING_TEXT[key];
}

/** Widgets that show numbers (CONTRACTS §28.2): the "N widgets" of the dashboard warning. */
const NO_DATA_TYPES: ReadonlySet<string> = new Set(['text', 'filter_control']);

/** Label column of the dialog's rows ("Who can open", "Link"). */
const ROW_LABEL = 'w-24 shrink-0 text-label text-fg-muted';

type Tab = 'link' | 'embed';
const TABS: readonly Tab[] = ['link', 'embed'];

/** What the scope warning covers: the settings that widen what people get. */
type WarningFor = (
  settings: Readonly<Record<FlagSetting, boolean>>,
  audience: 'org' | 'public',
) => ReactNode;

/**
 * "Share" dialog of a view (T316, SPEC §15A.1, CONTRACTS §16), laid out as
 * the design "Link chia sẻ" (T320): who can open it (segmented), the link
 * row (address, copy, new link), the amber scope warning with the fields
 * people will and will not see (acknowledged before creating or turning
 * on), the options in two columns — check boxes applied by "Create link"
 * before the link exists, switches that apply at once on an existing link
 * (T322b) — and a footer with revoke,
 * how often the link was opened and "Done". The address is shown in full
 * once after create/regenerate, then only its prefix — read-only, never
 * selected when the dialog opens again. The organization policy disables
 * the public option.
 *
 * (T814) Also the dialog of a dashboard (its options: live filters, polling
 * period, TV mode, widget CSV; its warning: numbers with the sharer's
 * permissions on N widgets), the "Allow downloading the data" option of
 * view links (`allow_export`, with the number of records in the warning),
 * and an "Embed" tab once a link exists (every target): the sites allowed
 * to frame it and the `<iframe>` code.
 */
export function ShareDialog({ target, base, onClose }: ShareDialogProps) {
  const { t } = useTranslation('share');
  const format = useFormatters();
  const view = target.kind === 'view' ? target.view : null;
  const dashboard = target.kind === 'dashboard' ? target.dashboard : null;
  const name = view?.name ?? dashboard?.name ?? '';
  const context: ShareContext = {
    target: { kind: target.kind, id: view?.id ?? dashboard?.id ?? '' },
    baseId: base.id,
    orgId: base.organization_id,
  };
  const targetType: ShareLinkTargetType = view === null ? 'dashboard' : targetTypeOf(view.type);
  const links = useQuery(targetShareLinksQuery(context.target));
  // No preview route for dashboards (CONTRACTS §16): their warning counts the widgets.
  const preview = useQuery({ ...shareLinkPreviewQuery(view?.id ?? ''), enabled: view !== null });
  const fields = useQuery({ ...fieldsQuery(view?.table_id ?? ''), enabled: view !== null });
  // The policy may have changed since the organization was cached.
  const org = useQuery({ ...orgQuery(base.organization_id), staleTime: 0 });
  const me = useQuery(meQuery());
  const orgName =
    org.data?.name ?? me.data?.orgs.find((item) => item.id === base.organization_id)?.name ?? '';
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [tab, setTab] = useState<Tab>('link');
  const link = links.data?.items[0];

  const onCreated = (created: CreatedShareLinkDto, message: string) => {
    setRevealed({ linkId: created.id, url: created.url });
    showToast({ variant: 'success', message });
  };

  // Attachment fields the link shows, split by the creator's right to download (T419).
  const fileFields =
    preview.data === undefined || view === null
      ? undefined
      : linkFileFields(preview.data.fields, (fieldId) =>
          canDownloadFile(base.access, view.table_id, fieldId),
        );
  const records =
    preview.data === undefined
      ? ''
      : t(preview.data.record_count_estimated ? 'scope.recordsEstimated' : 'scope.records', {
          count: preview.data.record_count ?? 0,
          formattedCount: format.number(preview.data.record_count ?? 0),
        });
  const warning: WarningFor = (settings, audience) =>
    dashboard === null ? (
      <ScopeWarning
        preview={preview.data}
        error={preview.error}
        audience={audience}
        hiddenFields={fields.data?.items}
        files={
          fileFields === undefined
            ? undefined
            : { ...fileFields, allowDownload: targetType !== 'form' && settings.allow_download }
        }
        allowExport={targetType === 'view' && settings.allow_export}
        acknowledged={acknowledged}
        onAcknowledge={setAcknowledged}
      />
    ) : (
      <DashboardScopeWarning
        widgets={dashboard.widgets.filter((widget) => !NO_DATA_TYPES.has(widget.type)).length}
        allowExport={settings.allow_export}
        acknowledged={acknowledged}
        onAcknowledge={setAcknowledged}
      />
    );
  const manageAll = isBaseAdmin(base.access) ? (
    <Link
      to={`/b/${encodeURIComponent(base.id)}/settings/share-links`}
      className="text-label font-normal text-accent underline-offset-4 hover:underline"
    >
      {t('dialog.manageAll')}
    </Link>
  ) : null;
  const shared = {
    context,
    targetType,
    policy: org.data?.settings.public_sharing,
    orgName,
    acknowledged,
    warning,
    manageAll,
    canExport: canDownload(base.access),
    exportText:
      targetType === 'dashboard'
        ? t('exportData.descriptionDashboard')
        : t('exportData.descriptionView', { records }),
    onClose,
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(tab);
    let next: Tab | undefined;
    if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length];
    else if (event.key === 'ArrowLeft') next = TABS[(index + TABS.length - 1) % TABS.length];
    else if (event.key === 'Home') next = TABS[0];
    else if (event.key === 'End') next = TABS[TABS.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`share-tab-${next}`)?.focus();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('dialog.title', { name })}
      description={
        targetType === 'form'
          ? t('dialog.descriptionForm')
          : targetType === 'dashboard'
            ? t('dialog.descriptionDashboard')
            : t('dialog.description')
      }
      closeLabel={t('actions.close')}
      // Phones: a bottom sheet whose footer ("Create link") stays in view (T322b).
      layout="sheet"
      className="max-h-[calc(100dvh-2rem)] max-w-3xl overflow-y-auto"
    >
      <div className="flex flex-col gap-4" data-testid="share-dialog">
        {links.isPending ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">{t('dialog.loading')}</span>
            <Skeleton className="h-8" />
            <Skeleton className="h-24" />
          </div>
        ) : links.isError ? (
          <ErrorAlert error={links.error} />
        ) : link === undefined ? (
          <LinkForm
            {...shared}
            onScopeWidened={() => {
              setAcknowledged(false);
            }}
            onCreated={(created) => {
              setAcknowledged(false);
              onCreated(created, t('created'));
            }}
          />
        ) : (
          <>
            <div
              role="tablist"
              aria-label={t('tabs.label')}
              className="-mx-6 flex gap-1 border-b border-line px-6"
            >
              {TABS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  id={`share-tab-${item}`}
                  aria-selected={tab === item}
                  aria-controls={`share-panel-${item}`}
                  tabIndex={tab === item ? 0 : -1}
                  data-testid={`share-tab-${item}`}
                  className={cn(
                    '-mb-px inline-flex min-h-control items-center border-b-2 px-3 text-body lg:min-h-9',
                    tab === item
                      ? 'border-accent font-medium text-fg'
                      : 'border-transparent text-fg-muted hover:text-fg',
                  )}
                  onClick={() => {
                    setTab(item);
                  }}
                  onKeyDown={onTabKey}
                >
                  {t(`tabs.${item}`)}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`share-panel-${tab}`} aria-labelledby={`share-tab-${tab}`}>
              {tab === 'link' ? (
                <LinkPanel
                  {...shared}
                  // A fresh draft for each link (a saved change resets it in place, so an
                  // immediate switch does not drop what waits for "Save").
                  key={link.id}
                  link={link}
                  revealed={revealed?.linkId === link.id ? revealed.url : null}
                  downloadable={fileFields?.downloadable ?? []}
                  onRegenerated={(created) => {
                    onCreated(created, t('regenerate.done'));
                  }}
                  onRevoked={() => {
                    setRevealed(null);
                    setAcknowledged(false);
                  }}
                />
              ) : (
                <EmbedPanel
                  link={link}
                  context={context}
                  name={name}
                  revealed={revealed?.linkId === link.id ? revealed.url : null}
                />
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Who can open the link: two segments ("In the organization" / "Public"),
 * native radio buttons underneath (arrow keys, screen readers), the hint of
 * the chosen one beside them.
 */
function AudienceControl({
  draft,
  onChange,
  targetType,
  policy,
  orgName,
}: {
  draft: ShareDraft;
  onChange: (draft: ShareDraft) => void;
  targetType: ShareLinkTargetType;
  policy: PublicSharingPolicy | undefined;
  orgName: string;
}) {
  const { t } = useTranslation('share');
  const name = useId();
  const hintId = useId();
  const blockedHintId = useId();
  const blocked = publicBlockedBy(policy, targetType);
  const options = [
    { value: 'org' as const, label: t('audience.org', { org: orgName }), disabled: false },
    { value: 'public' as const, label: t('audience.public'), disabled: blocked !== null },
  ];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{t('audience.legend')}</legend>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden="true" className={ROW_LABEL}>
          {t('audience.legend')}
        </span>
        <div className="grid h-8 w-full max-w-96 grid-cols-2 overflow-hidden rounded-md border border-line-control sm:w-96">
          {options.map((option) => (
            <label
              key={option.value}
              className={cn(
                'relative flex min-w-0 cursor-pointer items-center justify-center px-2 text-body',
                'has-[:checked]:bg-accent has-[:checked]:font-semibold has-[:checked]:text-on-accent',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent',
                'has-[:disabled]:cursor-not-allowed has-[:disabled]:text-fg-subtle',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={draft.audience === option.value}
                disabled={option.disabled}
                aria-describedby={
                  option.value === 'public' && blocked !== null
                    ? `${hintId} ${blockedHintId}`
                    : hintId
                }
                onChange={() => {
                  onChange({ ...draft, audience: option.value });
                }}
                // Covers its segment: a click (or a test's `check()`) lands on the radio itself.
                className="absolute inset-0 m-0 size-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
              />
              <span className="truncate">{option.label}</span>
            </label>
          ))}
        </div>
        <span id={hintId} className="text-label font-normal text-fg-muted">
          {draft.audience === 'org' ? t('audience.orgHint') : t('audience.publicHint')}
        </span>
      </div>
      {blocked === null ? null : (
        <p id={blockedHintId} className="text-label font-normal text-fg-muted sm:pl-27">
          {blocked === 'disabled' ? t('audience.publicDisabled') : t('audience.publicFormsOnly')}
        </p>
      )}
    </fieldset>
  );
}

/** (T814) How often a shared dashboard reads its numbers again (`refresh_seconds`). */
function RefreshControl({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean | undefined;
  onChange: (seconds: number) => void;
}) {
  const { t } = useTranslation('share');
  const id = useId();
  const hintId = useId();
  const choices: readonly number[] = (REFRESH_CHOICES as readonly number[]).includes(value)
    ? REFRESH_CHOICES
    : [...REFRESH_CHOICES, value].sort((a, b) => a - b);
  return (
    <div className="flex min-h-13 flex-col justify-center gap-1 border-b border-line py-2">
      <label htmlFor={id} className="font-medium text-fg">
        {t('settings.refresh')}
      </label>
      <Select
        id={id}
        className="w-48"
        value={String(value)}
        disabled={disabled}
        aria-describedby={hintId}
        data-testid="share-refresh"
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      >
        {choices.map((seconds) => (
          <option key={seconds} value={String(seconds)}>
            {seconds < 60 || seconds % 60 !== 0
              ? t('settings.refreshSeconds', { count: seconds })
              : seconds < 3600 || seconds % 3600 !== 0
                ? t('settings.refreshMinutes', { count: seconds / 60 })
                : t('settings.refreshHours', { count: seconds / 3600 })}
          </option>
        ))}
      </Select>
      <span id={hintId} className="text-label font-normal text-fg-muted">
        {t('settings.refreshHint')}
      </span>
    </div>
  );
}

interface OptionsProps {
  readonly draft: ShareDraft;
  readonly onChange: (draft: ShareDraft) => void;
  readonly targetType: ShareLinkTargetType;
  /** The link already has a password (empty input keeps it). */
  readonly hasPassword: boolean;
  readonly showErrors: boolean;
  /** The sharer may download data: without it a link cannot export either. */
  readonly canExport: boolean;
  /**
   * An existing link: what viewers may do is saved at once (switches);
   * without it (no link yet) every option is a check box of the draft.
   */
  readonly live?:
    | {
        readonly settings: Readonly<Record<FlagSetting, boolean>>;
        readonly onSetting: (key: FlagSetting, on: boolean) => void;
        readonly refreshSeconds: number;
        readonly onRefresh: (seconds: number) => void;
        readonly pending: boolean;
      }
    | undefined;
}

/**
 * Password, expiry and (view and dashboard links) what viewers may do, in
 * two columns. Password and expiry need a value and wait for "Create link"
 * / "Save": check boxes. Viewer settings of an existing link apply at once:
 * switches.
 */
function LinkOptions({
  draft,
  onChange,
  targetType,
  hasPassword,
  showErrors,
  canExport,
  live,
}: OptionsProps) {
  const { t } = useTranslation('share');
  const errors = showErrors ? validateDraft(draft, hasPassword) : {};
  const set = (patch: Partial<ShareDraft>) => {
    onChange({ ...draft, ...patch });
  };
  return (
    <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2" data-testid="share-options">
      <ShareOption
        control="checkbox"
        label={t('password.require')}
        hint={t('password.requireHint')}
        checked={draft.requirePassword}
        onChange={(event) => {
          set({ requirePassword: event.target.checked, password: '' });
        }}
      >
        <FormField
          label={t('password.label')}
          hint={
            hasPassword
              ? t('password.hintKeep')
              : t('password.hintNew', { min: SHARE_LINK_PASSWORD_MIN_LENGTH })
          }
          error={
            errors.password === undefined
              ? undefined
              : t('password.tooShort', { min: SHARE_LINK_PASSWORD_MIN_LENGTH })
          }
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              value={draft.password}
              onChange={(event) => {
                set({ password: event.target.value });
              }}
            />
          )}
        </FormField>
      </ShareOption>
      <ShareOption
        control="checkbox"
        label={t('expiry.enable')}
        hint={t('expiry.enableHint')}
        checked={draft.expires}
        onChange={(event) => {
          set({ expires: event.target.checked });
        }}
      >
        <FormField
          label={t('expiry.label')}
          hint={t('expiry.hint')}
          error={errors.expiresAt === undefined ? undefined : t('expiry.past')}
        >
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={draft.expiresAt}
              onChange={(event) => {
                set({ expiresAt: event.target.value });
              }}
            />
          )}
        </FormField>
      </ShareOption>
      {settingKeys(targetType).map((key) => {
        const text = settingText(key, targetType);
        // Exports need the sharer's own `download` right (the link never gets more).
        const noRight = key === 'allow_export' && !canExport;
        const hint = noRight ? t('settings.allowExportNoRight') : t(text.hint);
        return live === undefined ? (
          <ShareOption
            key={key}
            control="checkbox"
            label={t(text.label)}
            hint={hint}
            checked={draft.settings[key]}
            disabled={noRight && !draft.settings[key]}
            onChange={(event) => {
              set({ settings: { ...draft.settings, [key]: event.target.checked } });
            }}
          />
        ) : (
          <ShareOption
            key={key}
            control="switch"
            label={t(text.label)}
            hint={hint}
            checked={live.settings[key]}
            disabled={live.pending || (noRight && !live.settings[key])}
            onChange={(event) => {
              live.onSetting(key, event.target.checked);
            }}
          />
        );
      })}
      {targetType === 'dashboard' ? (
        <RefreshControl
          value={live === undefined ? draft.refreshSeconds : live.refreshSeconds}
          disabled={live?.pending}
          onChange={(seconds) => {
            if (live === undefined) set({ refreshSeconds: seconds });
            else live.onRefresh(seconds);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The link row: the address read-only (full once after create/regenerate,
 * then only its prefix), "Copy link" while the full address is known, and
 * "Create new link" for an existing link.
 */
function LinkRow({
  url,
  revealed,
  status,
  onRegenerate,
}: {
  url: string | null;
  revealed: boolean;
  status?: ReactNode;
  onRegenerate?: (() => void) | undefined;
}) {
  const { t } = useTranslation('share');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Selected once, right after it was created: ready to copy by hand if the clipboard fails.
    if (revealed) input.current?.select();
  }, [revealed, url]);
  const copy = async () => {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast({ variant: 'success', message: t('link.copied') });
    } catch {
      input.current?.select();
      showToast({ variant: 'error', message: t('link.copyFailed') });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className={ROW_LABEL} id="share-link-heading">
        {t('link.heading')}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {url === null ? (
          <p className="flex h-8.5 min-w-0 flex-1 items-center rounded-md border border-dashed border-line-strong px-3 text-label font-normal text-fg-muted">
            {t('link.notYet')}
          </p>
        ) : (
          <Input
            ref={input}
            readOnly
            aria-label={t('link.label')}
            value={url}
            className="h-8.5 min-w-0 flex-1 bg-surface-sunken font-mono text-mono text-fg-muted"
            data-testid="share-link-url"
            onFocus={(event) => {
              // Only the full address is worth selecting; a prefix cannot be used.
              if (revealed) event.target.select();
            }}
          />
        )}
        {revealed ? (
          <Button
            type="button"
            className="h-8.5"
            onClick={() => {
              void copy();
            }}
          >
            <Copy aria-hidden="true" />
            {t('link.copy')}
          </Button>
        ) : null}
        {onRegenerate === undefined ? null : (
          <Button type="button" variant="secondary" className="h-8.5" onClick={onRegenerate}>
            <RefreshCw aria-hidden="true" />
            {t('actions.regenerate')}
          </Button>
        )}
        {status}
      </div>
    </div>
  );
}

/** What both the new-link form and the link panel get from the dialog. */
interface SharedProps {
  readonly context: ShareContext;
  readonly targetType: ShareLinkTargetType;
  readonly policy: PublicSharingPolicy | undefined;
  readonly orgName: string;
  readonly acknowledged: boolean;
  readonly warning: WarningFor;
  readonly manageAll: ReactNode;
  readonly canExport: boolean;
  /** What turning exports on gives people with the link (records of the view, widget CSV). */
  readonly exportText: string;
  readonly onClose: () => void;
}

interface LinkFormProps extends SharedProps {
  /** An option now shares more (downloads or exports turned on): the warning must be read again. */
  readonly onScopeWidened: () => void;
  readonly onCreated: (created: CreatedShareLinkDto) => void;
}

/** Settings that widen what people with the link get: the warning is read again. */
const WIDENING: readonly FlagSetting[] = ['allow_download', 'allow_export'];

/** No link yet: the settings of the new link, the warning, "Create link". */
function LinkForm({
  context,
  targetType,
  policy,
  orgName,
  acknowledged,
  onScopeWidened,
  warning,
  manageAll,
  canExport,
  onCreated,
  onClose,
}: LinkFormProps) {
  const { t } = useTranslation('share');
  const [draft, setDraft] = useState(() => initialDraft());
  const [submitted, setSubmitted] = useState(false);
  const create = useCreateShareLink(context);
  const ackHintId = useId();
  const invalid = hasErrors(validateDraft(draft, false));
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (invalid || !acknowledged) return;
        create.mutate(createBody(draft, targetType), { onSuccess: onCreated });
      }}
    >
      <AudienceControl
        draft={draft}
        onChange={setDraft}
        targetType={targetType}
        policy={policy}
        orgName={orgName}
      />
      <LinkRow url={null} revealed={false} />
      {warning(draft.settings, draft.audience)}
      <LinkOptions
        draft={draft}
        onChange={(next) => {
          if (WIDENING.some((key) => next.settings[key] && !draft.settings[key])) onScopeWidened();
          setDraft(next);
        }}
        targetType={targetType}
        hasPassword={false}
        showErrors={submitted}
        canExport={canExport}
      />
      {create.isError ? <ErrorAlert error={create.error} /> : null}
      <DialogFooter>
        {manageAll}
        {acknowledged ? null : (
          <p
            id={ackHintId}
            className="min-w-0 text-label font-normal text-fg-muted max-sm:basis-full"
          >
            {t('scope.acknowledgeRequired')}
          </p>
        )}
        {/* Phones: the two buttons share their own row, "Create link" last (right). */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={create.isPending || !acknowledged}
            aria-describedby={acknowledged ? undefined : ackHintId}
          >
            {create.isPending ? <Spinner /> : null}
            {t('actions.create')}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

interface LinkPanelProps extends SharedProps {
  readonly link: ShareLinkDto;
  /** Full address when the token was just returned to this dialog. */
  readonly revealed: string | null;
  /** Attachment fields people with the link could download once downloads are on (T419). */
  readonly downloadable: readonly string[];
  readonly onRegenerated: (created: CreatedShareLinkDto) => void;
  readonly onRevoked: () => void;
}

type Confirm = 'regenerate' | 'revoke' | 'download' | 'exportData' | null;

/** The existing link: address, status, editable settings, turn on/off, regenerate, revoke. */
function LinkPanel({
  link,
  context,
  targetType,
  policy,
  orgName,
  revealed,
  acknowledged,
  warning,
  downloadable,
  manageAll,
  canExport,
  exportText,
  onRegenerated,
  onRevoked,
  onClose,
}: LinkPanelProps) {
  const { t } = useTranslation('share');
  const format = useFormatters();
  const [draft, setDraft] = useState(() => initialDraft(link));
  const [submitted, setSubmitted] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const update = useUpdateShareLink(context);
  // Viewer settings are switches: each change is saved at once (T322b).
  const settingsUpdate = useUpdateShareLink(context);
  const [pendingSettings, setPendingSettings] = useState<Partial<Record<FlagSetting, boolean>>>({});
  const [pendingRefresh, setPendingRefresh] = useState<number | null>(null);
  const regenerate = useRegenerateShareLink(context);
  const revoke = useRevokeShareLink(context);
  const ackHintId = useId();
  const saved = initialDraft(link);
  // A switch shows its new position until the refetched link says the same.
  const liveSettings = Object.fromEntries(
    (Object.keys(saved.settings) as FlagSetting[]).map((key) => [
      key,
      pendingSettings[key] ?? saved.settings[key],
    ]),
  ) as Record<FlagSetting, boolean>;
  const [seenSettings, setSeenSettings] = useState(link.settings);
  if (seenSettings !== link.settings) {
    setSeenSettings(link.settings);
    setPendingSettings((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key, value]) => flagOf(link.settings, key as FlagSetting) !== value,
        ),
      ),
    );
    if (pendingRefresh === link.settings.dashboard.refresh_seconds) setPendingRefresh(null);
  }
  const onSetting = (key: FlagSetting, on: boolean, confirmed = false) => {
    // Downloads and exports widen what people with the link get: confirmed first (T419, T814).
    if (on && !confirmed && (key === 'allow_download' || key === 'allow_export')) {
      setConfirm(key === 'allow_download' ? 'download' : 'exportData');
      return;
    }
    setPendingSettings((current) => ({ ...current, [key]: on }));
    settingsUpdate.mutate(
      { linkId: link.id, body: { settings: flagPatch(key, on) } },
      {
        onSuccess: () => {
          showToast({ variant: 'success', message: t('actions.saved') });
        },
        onError: () => {
          setPendingSettings((current) =>
            Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)),
          );
        },
      },
    );
  };
  const onRefresh = (seconds: number) => {
    setPendingRefresh(seconds);
    settingsUpdate.mutate(
      { linkId: link.id, body: { settings: { dashboard: { refresh_seconds: seconds } } } },
      {
        onSuccess: () => {
          showToast({ variant: 'success', message: t('actions.saved') });
        },
        onError: () => {
          setPendingRefresh(null);
        },
      },
    );
  };
  // The draft holds what waits for "Save" (audience, password, expiry), not the switches.
  const body = updateBody(
    { ...draft, settings: saved.settings, refreshSeconds: saved.refreshSeconds },
    link,
    targetType,
  );
  const invalid = hasErrors(validateDraft(draft, link.has_password));
  const needsAck = widensAudience(body);
  // Saving makes the link impossible to embed: embedding goes off with it.
  const endsEmbed = body?.settings?.embed?.enabled === false;
  const error = update.error ?? settingsUpdate.error ?? regenerate.error ?? revoke.error;

  const statusText =
    link.status === 'blocked'
      ? t('link.blocked')
      : link.status === 'expired'
        ? t('link.expired')
        : link.status === 'disabled'
          ? t('link.disabled')
          : null;

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (body === null || invalid || (needsAck && !acknowledged)) return;
        update.mutate(
          { linkId: link.id, body },
          {
            onSuccess: (updated) => {
              // Saved: the draft starts again from the link as it is now.
              setDraft(initialDraft(updated));
              setSubmitted(false);
              showToast({ variant: 'success', message: t('actions.saved') });
            },
          },
        );
      }}
    >
      <AudienceControl
        draft={draft}
        onChange={setDraft}
        targetType={targetType}
        policy={policy}
        orgName={orgName}
      />
      <section aria-labelledby="share-link-heading" className="flex flex-col gap-2">
        <LinkRow
          url={revealed ?? maskedUrl(window.location.origin, link.token_prefix)}
          revealed={revealed !== null}
          status={<StatusBadge status={link.status} />}
          onRegenerate={() => {
            setConfirm('regenerate');
          }}
        />
        {revealed === null ? (
          <p className="text-label font-normal text-fg-muted sm:pl-27">{t('link.hidden')}</p>
        ) : (
          <Alert variant="info" data-testid="share-link-once">
            <p className="font-semibold">{t('link.onceTitle')}</p>
            <p>{t('link.once')}</p>
          </Alert>
        )}
        {statusText === null ? null : (
          <Alert variant={link.status === 'blocked' ? 'danger' : 'info'} role="status">
            {statusText}
          </Alert>
        )}
      </section>
      {warning(liveSettings, draft.audience)}
      <LinkOptions
        draft={draft}
        onChange={setDraft}
        targetType={targetType}
        hasPassword={link.has_password}
        showErrors={submitted}
        canExport={canExport}
        live={{
          settings: liveSettings,
          onSetting,
          refreshSeconds: pendingRefresh ?? link.settings.dashboard.refresh_seconds,
          onRefresh,
          pending: settingsUpdate.isPending,
        }}
      />
      {endsEmbed ? (
        <Alert variant="info" data-testid="share-embed-ends">
          {t('embed.endsOnSave')}
        </Alert>
      ) : null}
      {error === null ? null : <ErrorAlert error={error} />}
      {confirm === null ? null : (
        <ConfirmPanel
          kind={confirm}
          description={
            confirm === 'download'
              ? downloadable.length === 0
                ? t('download.descriptionNone')
                : t('download.description', { fields: downloadable.join(', ') })
              : confirm === 'exportData'
                ? exportText
                : t(`${confirm}.description`)
          }
          pending={regenerate.isPending || revoke.isPending}
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={() => {
            if (confirm === 'download') {
              setConfirm(null);
              onSetting('allow_download', true, true);
            } else if (confirm === 'exportData') {
              setConfirm(null);
              onSetting('allow_export', true, true);
            } else if (confirm === 'regenerate') {
              regenerate.mutate(link.id, {
                onSuccess: (created) => {
                  setConfirm(null);
                  onRegenerated(created);
                },
              });
            } else {
              revoke.mutate(link.id, {
                onSuccess: () => {
                  showToast({ variant: 'success', message: t('revoke.done') });
                  onRevoked();
                },
              });
            }
          }}
        />
      )}
      {acknowledged || (link.enabled && !needsAck) ? null : (
        <p id={ackHintId} className="text-label font-normal text-fg-muted">
          {t('scope.acknowledgeRequired')}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          className="text-danger hover:text-danger"
          onClick={() => {
            setConfirm('revoke');
          }}
        >
          {t('actions.revoke')}
        </Button>
        <span className="text-label font-normal text-fg-muted" data-testid="share-link-stats">
          {accessSummary(t, link, format.relative)}
        </span>
        {manageAll}
        <Button
          type="button"
          variant="secondary"
          className="sm:ml-auto"
          disabled={update.isPending || (!link.enabled && !acknowledged)}
          aria-describedby={!link.enabled && !acknowledged ? ackHintId : undefined}
          onClick={() => {
            const enabled = !link.enabled;
            update.mutate(
              { linkId: link.id, body: { enabled } },
              {
                onSuccess: () => {
                  showToast({
                    variant: 'success',
                    message: enabled ? t('actions.enabled') : t('actions.disabled'),
                  });
                },
              },
            );
          }}
        >
          {link.enabled ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
          {link.enabled ? t('actions.disable') : t('actions.enable')}
        </Button>
        {body === null ? (
          <Button type="button" onClick={onClose}>
            {t('actions.done')}
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={update.isPending || (needsAck && !acknowledged)}
            aria-describedby={needsAck && !acknowledged ? ackHintId : undefined}
          >
            {update.isPending ? <Spinner /> : null}
            {t('actions.save')}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/**
 * The dialog's footer, kept at the bottom edge while the options scroll
 * (sticky), so "Create link" / "Save" is always in reach — on phones too,
 * where the dialog is a bottom sheet (T322b).
 */
function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div
      className="sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface px-6 py-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      data-testid="share-dialog-footer"
    >
      {children}
    </div>
  );
}

/**
 * Inline confirmation of regenerate / revoke / turning downloads or (T814)
 * data exports on (inside the dialog, focus moved to it). Downloads list
 * the file fields people with the link could then download (T419); exports
 * say how many records (views) or that each widget's numbers (dashboards)
 * can be downloaded.
 */
function ConfirmPanel({
  kind,
  description,
  pending,
  onCancel,
  onConfirm,
}: {
  kind: 'regenerate' | 'revoke' | 'download' | 'exportData';
  description: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('share');
  const titleId = useId();
  const descriptionId = useId();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const widening = kind === 'download' || kind === 'exportData';
  useEffect(() => {
    confirmButton.current?.focus();
  }, [kind]);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn(
        'flex flex-col gap-2 rounded-md border px-3 py-2',
        widening ? 'border-warning bg-option-3' : 'border-danger',
      )}
      data-testid={`share-confirm-${kind}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // Close only the confirmation, not the dialog.
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id={titleId} className="font-semibold">
        {t(`${kind}.title`)}
      </p>
      <p id={descriptionId} className="text-body">
        {description}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t('actions.cancel')}
        </Button>
        <Button
          ref={confirmButton}
          type="button"
          variant={widening ? 'primary' : 'danger'}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? <Spinner /> : null}
          {t(`${kind}.confirm`)}
        </Button>
      </div>
    </div>
  );
}

export default ShareDialog;
