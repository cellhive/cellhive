import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import {
  CirclePause,
  CirclePlay,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../../lib/i18n/format';
import { readableAddress } from '../model/sender';

import { StatusBadge } from './parts';

import type { EmailIdentityDto } from '@cellhive/contracts';

export interface IdentityRowActions {
  readonly onEdit: (identity: EmailIdentityDto) => void;
  /** (T556) "Fix display name" of a name saved before T540 (the form, focus on the name). */
  readonly onFixName: (identity: EmailIdentityDto) => void;
  /** Code entry, resend or "Test & verify" (the verification view of the drawer). */
  readonly onVerify: (identity: EmailIdentityDto) => void;
  readonly onToggle: (identity: EmailIdentityDto) => void;
  readonly onDelete: (identity: EmailIdentityDto) => void;
}

export interface IdentityListProps extends IdentityRowActions {
  readonly items: readonly EmailIdentityDto[];
  /** Base id → name (bases the caller sees). */
  readonly baseNames: ReadonlyMap<string, string>;
  /** Identity id → automations using it (`undefined` while loading). */
  readonly usageCounts: ReadonlyMap<string, number>;
  readonly busyId: string | null;
}

function ScopeText({
  identity,
  baseNames,
}: {
  readonly identity: EmailIdentityDto;
  readonly baseNames: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation('emailIdentities');
  if (identity.base_scope === 'all') return <>{t('scope.all')}</>;
  if (identity.base_ids.length === 0) return <>{t('scope.none')}</>;
  const names = identity.base_ids.map((baseId) => baseNames.get(baseId) ?? t('scope.unknownBase'));
  return <>{names.join(', ')}</>;
}

/** The line under the status: when it was verified, what is pending, why it failed. */
function StatusLine({ identity }: { readonly identity: EmailIdentityDto }) {
  const { t } = useTranslation('emailIdentities');
  const format = useFormatters();
  let text: string | null = null;
  if (identity.status === 'verified' && identity.verified_at !== null) {
    text = t(`statusLine.verified_${identity.verified_via ?? 'code'}`, {
      date: format.date(identity.verified_at),
    });
  } else if (identity.status === 'pending') {
    text =
      identity.verification.pending && identity.verification.expires_at !== null
        ? t('statusLine.pendingUntil', { date: format.dateTime(identity.verification.expires_at) })
        : t('statusLine.pendingNone');
  } else if (identity.status === 'error') {
    text = t(`statusLine.error_${identity.error_reason ?? 'auth_failed'}`);
  } else if (identity.status === 'disabled') {
    text = t('statusLine.disabled');
  }
  return text === null ? null : (
    <span className="text-label font-normal text-fg-muted">{text}</span>
  );
}

/** The one fix of a status, next to it (board: "Nhập mã", "Gửi lại thư", "Bật lại"). */
function StatusAction({
  identity,
  busy,
  onVerify,
  onToggle,
}: {
  readonly identity: EmailIdentityDto;
  readonly busy: boolean;
} & Pick<IdentityRowActions, 'onVerify' | 'onToggle'>) {
  const { t } = useTranslation('emailIdentities');
  let label: string | null = null;
  let onClick = () => {
    onVerify(identity);
  };
  if (identity.status === 'pending') {
    label = identity.verification.pending ? t('row.enterCode') : t('row.resend');
    if (identity.transport === 'smtp' && !identity.verification.pending) label = t('row.test');
  } else if (identity.status === 'error') {
    label = identity.transport === 'smtp' ? t('row.test') : t('row.resend');
  } else if (identity.status === 'disabled') {
    label = t('row.enable');
    onClick = () => {
      onToggle(identity);
    };
  }
  if (label === null) return null;
  return (
    <Button
      variant="link"
      size="sm"
      className="w-fit text-label max-lg:min-h-control"
      disabled={busy}
      aria-label={`${label} · ${identity.display_name}`}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function RowMenu({
  identity,
  busy,
  onEdit,
  onVerify,
  onToggle,
  onDelete,
}: { readonly identity: EmailIdentityDto; readonly busy: boolean } & IdentityRowActions) {
  const { t } = useTranslation('emailIdentities');
  const verifiable = identity.status === 'pending' || identity.status === 'error';
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={t('row.menu', { name: identity.display_name })}
        disabled={busy}
        data-testid={`identity-menu-${identity.id}`}
        className="flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 max-lg:size-control"
      >
        <MoreHorizontal aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            onEdit(identity);
          }}
        >
          <Pencil aria-hidden="true" />
          {t('row.edit')}
        </DropdownMenuItem>
        {verifiable ? (
          <DropdownMenuItem
            onSelect={() => {
              onVerify(identity);
            }}
          >
            {identity.transport === 'smtp' ? (
              <ShieldCheck aria-hidden="true" />
            ) : (
              <KeyRound aria-hidden="true" />
            )}
            {t('row.verify')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => {
            onToggle(identity);
          }}
        >
          {identity.status === 'disabled' ? (
            <CirclePlay aria-hidden="true" />
          ) : (
            <CirclePause aria-hidden="true" />
          )}
          {identity.status === 'disabled' ? t('row.enable') : t('row.disable')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-danger [&_svg]:text-danger"
          onSelect={() => {
            onDelete(identity);
          }}
        >
          <Trash2 aria-hidden="true" />
          {t('row.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * (T556, QA S5 M7) A display name saved before T540 that the server would
 * refuse today (`display_name_issue`, CONTRACTS §23.3): kept and still sent
 * until an admin changes it, so the row says so — a warning label (icon +
 * words, never color alone), why, and "Fix display name".
 */
function NameIssue({
  identity,
  onFixName,
}: {
  readonly identity: EmailIdentityDto;
  readonly onFixName: (identity: EmailIdentityDto) => void;
}) {
  const { t } = useTranslation(['emailIdentities', 'errors']);
  const reasonId = useId();
  const issue = identity.display_name_issue;
  if (issue === null) return null;
  const fix = t('nameIssue.fix');
  return (
    <span className="mt-1 flex flex-col items-start gap-1" data-testid="display-name-issue">
      <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-option-3 px-1.5 py-0.5 text-label font-medium text-on-option-3">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        {t('nameIssue.badge')}
      </span>
      <span id={reasonId} className="text-label font-normal text-fg-muted">
        {t('errors:detail.DISPLAY_NAME_NOT_ALLOWED', { context: issue })}
      </span>
      <Button
        variant="link"
        size="sm"
        className="w-fit text-label max-lg:min-h-control"
        aria-label={`${fix} · ${identity.display_name}`}
        aria-describedby={reasonId}
        data-testid="fix-display-name"
        onClick={() => {
          onFixName(identity);
        }}
      >
        {fix}
      </Button>
    </span>
  );
}

function IdentityName({
  identity,
  onFixName,
}: {
  readonly identity: EmailIdentityDto;
  readonly onFixName: (identity: EmailIdentityDto) => void;
}) {
  const { t } = useTranslation('emailIdentities');
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="font-medium break-words text-fg">{identity.display_name}</span>
      {/* A narrow column breaks the address before "@" rather than inside a word. */}
      <span className="text-label font-normal [overflow-wrap:anywhere] text-fg-muted">
        {identity.email.slice(0, identity.email.lastIndexOf('@'))}
        <wbr />
        {identity.email.slice(identity.email.lastIndexOf('@'))}
      </span>
      {identity.smtp === null ? null : (
        <span className="inline-flex items-center gap-1 text-label font-normal text-fg-muted">
          <Server aria-hidden="true" className="size-3.5 shrink-0" />
          {t('row.ownServer', { host: identity.smtp.host })}
        </span>
      )}
      <NameIssue identity={identity} onFixName={onFixName} />
    </span>
  );
}

function SendsAs({ identity }: { readonly identity: EmailIdentityDto }) {
  const { t } = useTranslation('emailIdentities');
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-body text-fg">{t(`mode.${identity.mode}`)}</span>
      <span className="text-label font-normal break-words text-fg-muted">
        {t('row.shownAs', { from: readableAddress(identity.display.from) })}
      </span>
    </span>
  );
}

const TH = 'h-[34px] px-3 text-left text-label font-medium whitespace-nowrap text-fg-muted';
const TD = 'px-3 py-3 align-top';

/** ≥ 768 px: one row per identity (board "S5 · Email identities & signatures"). */
export function IdentityTable({
  items,
  baseNames,
  usageCounts,
  busyId,
  ...actions
}: IdentityListProps) {
  const { t } = useTranslation('emailIdentities');
  const format = useFormatters();
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[760px] border-collapse text-body">
        <caption className="sr-only">{t('list.caption')}</caption>
        <thead className="bg-surface-sunken">
          <tr>
            <th scope="col" className={TH}>
              {t('list.identity')}
            </th>
            <th scope="col" className={TH}>
              {t('list.sending')}
            </th>
            <th scope="col" className={TH}>
              {t('list.status')}
            </th>
            <th scope="col" className={TH}>
              {t('list.scope')}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              {t('list.automations')}
            </th>
            <th scope="col" className={TH}>
              <span className="sr-only">{t('list.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((identity) => {
            const busy = busyId === identity.id;
            const usage = usageCounts.get(identity.id);
            return (
              <tr
                key={identity.id}
                data-testid={`identity-row-${identity.id}`}
                aria-busy={busy || undefined}
                className="border-t border-line"
              >
                <td className={TD}>
                  <IdentityName identity={identity} onFixName={actions.onFixName} />
                </td>
                <td className={TD}>
                  <SendsAs identity={identity} />
                </td>
                <td className={TD}>
                  <span className="flex flex-col items-start gap-1">
                    <StatusBadge status={identity.status} />
                    <StatusLine identity={identity} />
                    <StatusAction identity={identity} busy={busy} {...actions} />
                  </span>
                </td>
                <td className={`${TD} text-fg-muted`}>
                  <ScopeText identity={identity} baseNames={baseNames} />
                </td>
                <td className={`${TD} text-right tabular-nums`} data-testid="identity-usage">
                  {usage === undefined ? (
                    <span aria-label={t('list.usageLoading')}>—</span>
                  ) : (
                    format.number(usage)
                  )}
                </td>
                <td className={`${TD} w-12 text-right`}>
                  <RowMenu identity={identity} busy={busy} {...actions} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** < 768 px: one card per identity, the same facts stacked. */
export function IdentityCards({
  items,
  baseNames,
  usageCounts,
  busyId,
  ...actions
}: IdentityListProps) {
  const { t } = useTranslation('emailIdentities');
  const format = useFormatters();
  return (
    <ul aria-label={t('list.caption')} className="flex flex-col gap-3">
      {items.map((identity) => {
        const busy = busyId === identity.id;
        const usage = usageCounts.get(identity.id);
        return (
          <li
            key={identity.id}
            data-testid={`identity-card-${identity.id}`}
            aria-busy={busy || undefined}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <IdentityName identity={identity} onFixName={actions.onFixName} />
              <RowMenu identity={identity} busy={busy} {...actions} />
            </div>
            <div className="flex flex-col items-start gap-1">
              <StatusBadge status={identity.status} />
              <StatusLine identity={identity} />
            </div>
            <SendsAs identity={identity} />
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
              <dt className="text-fg-muted">{t('list.scope')}</dt>
              <dd className="font-normal">
                <ScopeText identity={identity} baseNames={baseNames} />
              </dd>
              <dt className="text-fg-muted">{t('list.automations')}</dt>
              <dd className="font-normal tabular-nums">
                {usage === undefined ? '—' : format.number(usage)}
              </dd>
            </dl>
            <StatusAction identity={identity} busy={busy} {...actions} />
          </li>
        );
      })}
    </ul>
  );
}
