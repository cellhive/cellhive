import { buttonVariants, cn } from '@cellhive/ui';
import {
  EyeOff,
  FileX,
  KeyRound,
  PackageCheck,
  Power,
  Sparkles,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useFormatters } from '../../../lib/i18n/format';

import type { BaseImportDetachedItem, BaseImportReport } from '@cellhive/contracts';
import type { ReactNode } from 'react';

/** `data-testid` of each section of the report. */
const SECTION_TEST_IDS = {
  automations: 'import-report-automations',
  reconnect: 'import-report-reconnect',
  people: 'import-report-people',
  ai: 'import-report-ai',
  views: 'import-report-views',
  files: 'import-report-files',
} as const;

/** Emails shown before "And N more" (the report lists up to 1,000). */
export const REPORT_EMAILS_SHOWN = 8;

const COUNTS = [
  ['tables', 'tables'],
  ['fields', 'fields'],
  ['records', 'records'],
  ['links', 'links'],
  ['files', 'attachments'],
  ['views', 'views'],
  ['dashboards', 'dashboards'],
  ['automations', 'automations'],
  ['roles', 'roles'],
] as const satisfies readonly (readonly [string, keyof BaseImportReport])[];

function Section({
  icon: Icon,
  title,
  count,
  testId,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  /** A number beside the title (how many items), formatted. */
  readonly count?: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      className="flex animate-reveal flex-col gap-2 rounded-lg border border-line p-4"
      data-testid={testId}
    >
      <h3 className="flex items-center gap-2 text-body font-medium">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1">{title}</span>
        {count === undefined ? null : (
          <span className="rounded-sm bg-surface-sunken px-2 text-label tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function DetachedList({
  items,
  baseId,
}: {
  readonly items: readonly BaseImportDetachedItem[];
  readonly baseId: string;
}) {
  const { t } = useTranslation('workspace');
  return (
    <ul className="flex flex-col divide-y divide-line">
      {items.map((item) => (
        <li
          key={`${item.kind}:${item.name}`}
          className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0"
        >
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-label font-normal text-fg-muted">
              {t(`import.report.kinds.${item.kind}`)}
            </span>
            <span className="font-medium break-words">
              {item.name === '' ? t('import.report.unnamed') : item.name}
            </span>
          </span>
          {item.automations.length === 0 ? null : (
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-fg-muted">
              <span>{t('import.report.reconnect.usedBy')}</span>
              {item.automations.map((automation) => (
                <Link
                  key={automation.id}
                  to={`/b/${encodeURIComponent(baseId)}/automations/${encodeURIComponent(automation.id)}`}
                  className="text-accent underline-offset-4 hover:underline"
                >
                  {automation.name}
                </Link>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface ImportReportProps {
  readonly baseId: string;
  /** Name of the new base (the file name until the base loads). */
  readonly baseName: string;
  readonly workspaceName: string;
  readonly report: BaseImportReport;
  /** "Close" beside "Open base". */
  readonly closeButton: ReactNode;
}

/**
 * The report of a finished `.chbase` import (CONTRACTS §12.2,
 * `BaseImportReport`, FRONTEND §17.5): what was created, then only the
 * sections that need the importer — automations turned off, secrets,
 * sending identities, groups and incoming webhooks to set up again (with a
 * link to each automation using them), people of the package who are not
 * members here, AI fields, personal views left out, files left out — and
 * the way into the new base.
 */
export function ImportReport({
  baseId,
  baseName,
  workspaceName,
  report,
  closeButton,
}: ImportReportProps) {
  const { t } = useTranslation('workspace');
  const format = useFormatters();
  const detached = [...report.secrets_to_reconnect, ...report.webhooks_to_recreate];
  const emails = report.unmatched_user_emails;
  const hiddenEmails = Math.max(
    0,
    report.unmatched_users - Math.min(emails.length, REPORT_EMAILS_SHOWN),
  );
  const sections: ReactNode[] = [];

  if (report.automations_disabled > 0) {
    sections.push(
      <Section
        key="automations"
        icon={Power}
        title={t('import.report.automations.title')}
        testId={SECTION_TEST_IDS.automations}
      >
        <p className="text-fg-muted">
          {t('import.report.automations.body', { count: report.automations_disabled })}
        </p>
      </Section>,
    );
  }
  if (detached.length > 0) {
    sections.push(
      <Section
        key="reconnect"
        icon={KeyRound}
        title={t('import.report.reconnect.title')}
        count={format.number(detached.length)}
        testId={SECTION_TEST_IDS.reconnect}
      >
        <p className="text-fg-muted">{t('import.report.reconnect.body')}</p>
        <DetachedList items={detached} baseId={baseId} />
      </Section>,
    );
  }
  if (report.unmatched_users > 0) {
    sections.push(
      <Section
        key="people"
        icon={UserX}
        title={t('import.report.people.title')}
        count={format.number(report.unmatched_users)}
        testId={SECTION_TEST_IDS.people}
      >
        <p className="text-fg-muted">{t('import.report.people.body')}</p>
        <ul className="flex flex-wrap gap-2">
          {emails.slice(0, REPORT_EMAILS_SHOWN).map((email) => (
            <li
              key={email}
              className="max-w-full truncate rounded-sm bg-surface-sunken px-2 py-0.5 text-label font-normal"
            >
              {email}
            </li>
          ))}
        </ul>
        {hiddenEmails > 0 ? (
          <p className="text-fg-muted">{t('import.report.people.more', { count: hiddenEmails })}</p>
        ) : null}
      </Section>,
    );
  }
  if (report.ai_fields.length > 0) {
    sections.push(
      <Section
        key="ai"
        icon={Sparkles}
        title={t('import.report.ai.title')}
        count={format.number(report.ai_fields.length)}
        testId={SECTION_TEST_IDS.ai}
      >
        <p className="text-fg-muted">{t('import.report.ai.body')}</p>
        <ul className="flex flex-wrap gap-2">
          {report.ai_fields.map((field) => (
            <li key={field.field_id}>
              <Link
                to={`/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(field.table_id)}`}
                className="inline-block max-w-full truncate rounded-sm bg-surface-sunken px-2 py-0.5 text-label font-normal text-fg hover:underline"
              >
                {field.name}
              </Link>
            </li>
          ))}
        </ul>
      </Section>,
    );
  }
  if (report.skipped_personal_views > 0) {
    sections.push(
      <Section
        key="views"
        icon={EyeOff}
        title={t('import.report.views.title')}
        count={format.number(report.skipped_personal_views)}
        testId={SECTION_TEST_IDS.views}
      >
        <p className="text-fg-muted">
          {t('import.report.views.body', { count: report.skipped_personal_views })}
        </p>
      </Section>,
    );
  }
  if (report.files_skipped.length > 0) {
    sections.push(
      <Section
        key="files"
        icon={FileX}
        title={t('import.report.files.title')}
        count={format.number(report.files_skipped.length)}
        testId={SECTION_TEST_IDS.files}
      >
        <p className="text-fg-muted">{t('import.report.files.body')}</p>
        <ul className="flex flex-col gap-1">
          {report.files_skipped.map((file, index) => (
            <li
              // Two files of the package may share a name.
              key={`${file.filename}:${String(index)}`}
              className="flex flex-wrap items-baseline gap-x-2"
            >
              <span className="min-w-0 font-medium break-all">{file.filename}</span>
              <span className="text-fg-muted">
                {t(`import.report.files.reasons.${file.reason}`)}
              </span>
            </li>
          ))}
        </ul>
      </Section>,
    );
  }

  return (
    <div className="flex flex-col gap-5" data-testid="import-report">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 animate-pop-in items-center justify-center rounded-full bg-accent-soft text-accent">
          <PackageCheck aria-hidden="true" className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col" role="status">
          <p className="text-heading break-words">{t('import.report.title', { name: baseName })}</p>
          <p className="text-fg-muted">
            {t('import.report.subtitle', { workspace: workspaceName })}
          </p>
        </div>
      </div>
      <dl
        aria-label={t('import.report.counts.label')}
        className="grid grid-cols-3 gap-2"
        data-testid="import-report-counts"
      >
        {COUNTS.map(([label, key]) => (
          <div
            key={key}
            className="flex min-w-0 flex-col gap-0.5 rounded-md border border-line bg-surface-sunken px-3 py-2"
          >
            <dt className="truncate text-label font-normal text-fg-muted">
              {t(`import.report.counts.${label}`)}
            </dt>
            <dd className="text-heading tabular-nums">{format.number(report[key])}</dd>
          </div>
        ))}
      </dl>
      {sections.length === 0 ? (
        <p className="text-fg-muted">{t('import.report.allGood')}</p>
      ) : (
        <div className="flex flex-col gap-3">{sections}</div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {closeButton}
        <Link
          to={`/b/${encodeURIComponent(baseId)}`}
          className={cn(buttonVariants({ variant: 'primary' }))}
          data-testid="import-open-base"
        >
          {t('import.report.open')}
        </Link>
      </div>
    </div>
  );
}
