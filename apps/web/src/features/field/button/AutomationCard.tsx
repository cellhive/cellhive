import { Button, cn, Skeleton, Spinner } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Plus, TriangleAlert, Zap } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { canManageAutomations } from '../../../lib/permissions/access';
import { automationQuery } from '../../../lib/query/automations';
import { fieldsQuery } from '../../../lib/query/queries';

import { summarizeCondition } from './summary';

import type { BaseDetail, FieldDto } from '@cellhive/contracts';

/** Builder of a new automation for a saved button: trigger `button.clicked` on it, prefilled. */
export function newButtonAutomationPath(
  baseId: string,
  tableId: string,
  fieldId: string,
  name: string,
): string {
  const query = new URLSearchParams({
    trigger: 'button.clicked',
    table: tableId,
    field: fieldId,
    name,
  });
  return `/b/${baseId}/automations/new?${query.toString()}`;
}

export interface AutomationCardProps {
  readonly base: BaseDetail | undefined;
  readonly tableId: string;
  /** The saved field; absent: a new field (saved first by `onCreateNew`). */
  readonly field: FieldDto | undefined;
  /** The button's label (names the new automation). */
  readonly label: string;
  /** New field: saves it first; `null` when it was not created. */
  readonly saveField: () => Promise<FieldDto | null>;
  /** The builder opens: the dialog closes. */
  readonly onLeave: () => void;
  readonly creating: boolean;
}

/**
 * "Automation run by the button" in the field dialog (T525, board "S5 ·
 * Button field - cấu hình"): the attached automation — name, on/off,
 * `run_as`, who may click (read-only: `min_permission` is edited in the
 * builder only because changing it moves `run_as`, Quyết định S5 thiết kế
 * #8), the condition and the steps — with "Open in builder"; or, without
 * one, "Create an automation for this button" (the builder opens with the
 * `button.clicked` trigger prefilled). One automation per button
 * (`BUTTON_IN_USE`).
 */
export function AutomationCard({
  base,
  tableId,
  field,
  label,
  saveField,
  onLeave,
  creating,
}: AutomationCardProps) {
  const { t } = useTranslation(['field', 'automationBuilder', 'toolbar']);
  const navigate = useNavigate();
  const headingId = useId();
  const summary = field?.button;
  const automationId = summary?.automation_id ?? null;
  const baseId = base?.id ?? '';
  const manages = base !== undefined && canManageAutomations(base.access, tableId);
  const details = useQuery({
    ...automationQuery(baseId, automationId ?? ''),
    enabled: automationId !== null && manages,
    retry: false,
  });
  const tableFields = useQuery({ ...fieldsQuery(tableId), enabled: details.data !== undefined });

  /** "Status is Pending and …" (top-level conditions; groups counted). */
  const conditionText = (filter: unknown): string => {
    const summary = summarizeCondition(filter, tableFields.data?.items ?? []);
    if (summary === null) return t('button.automation.always');
    const parts = summary.parts.map((part) =>
      [
        part.field ?? t('toolbar:filter.unknownField'),
        t(`toolbar:filter.operators.${part.operator}` as 'toolbar:filter.operators.is'),
        part.value,
      ]
        .filter((piece) => piece !== null)
        .join(' '),
    );
    if (summary.more > 0) parts.push(t('button.automation.more', { count: summary.more }));
    return parts.join(` ${t(`button.automation.${summary.op}`)} `);
  };

  let body;
  if (automationId === null || summary === undefined) {
    body = (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line-strong p-4">
        <span className="text-body font-medium">{t('button.automation.none')}</span>
        <p className="text-label font-normal text-fg-muted">{t('button.automation.noneHint')}</p>
        {!manages ? null : field === undefined ? (
          <Button
            type="button"
            disabled={creating}
            data-testid="button-create-automation"
            onClick={() => {
              void saveField().then((created) => {
                if (created === null) return;
                void navigate(newButtonAutomationPath(baseId, tableId, created.id, label));
                onLeave();
              });
            }}
          >
            {creating ? <Spinner /> : <Plus aria-hidden="true" />}
            {t('button.automation.saveAndCreate')}
          </Button>
        ) : (
          <Link
            to={newButtonAutomationPath(baseId, tableId, field.id, label)}
            data-testid="button-create-automation"
            onClick={onLeave}
            className="inline-flex h-control items-center gap-1.5 rounded-md bg-accent px-3.5 text-body font-medium text-on-accent hover:bg-accent-hover"
          >
            <Plus aria-hidden="true" className="size-4" />
            {t('button.automation.create')}
          </Link>
        )}
      </div>
    );
  } else {
    const automation = details.data;
    const read = summary.min_permission === 'read';
    body = (
      <div
        className="flex flex-col gap-2.5 rounded-lg border border-line p-3"
        data-testid="button-automation"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Zap aria-hidden="true" className="size-4 shrink-0 text-accent" />
          {automation === undefined ? (
            details.isPending && manages ? (
              <Skeleton className="h-4 w-32" />
            ) : (
              <span className="font-medium">{t('button.automation.unnamed')}</span>
            )
          ) : (
            <span className="min-w-0 truncate font-medium">{automation.name}</span>
          )}
          <span
            className={cn(
              'inline-flex h-5.5 items-center rounded-sm px-2 text-label',
              summary.automation_enabled
                ? 'bg-option-2 text-on-option-2'
                : 'bg-surface-sunken text-fg-muted',
            )}
          >
            {t(summary.automation_enabled ? 'button.automation.on' : 'button.automation.off')}
          </span>
          {manages ? (
            <Link
              to={`/b/${baseId}/automations/${automationId}`}
              className="ml-auto inline-flex min-h-control items-center gap-1 text-label font-medium text-accent hover:underline lg:min-h-0"
              data-testid="button-open-automation"
            >
              {t('button.automation.open')}
              <ExternalLink aria-hidden="true" className="size-3" />
            </Link>
          ) : null}
        </div>
        <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-label font-normal">
          {automation === undefined ? null : (
            <>
              <dt className="text-fg-muted">{t('button.automation.runAs')}</dt>
              <dd>{automation.run_as.name}</dd>
            </>
          )}
          <dt className="text-fg-muted">{t('button.automation.whoClicks')}</dt>
          <dd data-testid="button-min-permission">
            {t(read ? 'button.automation.readers' : 'button.automation.editors')}
          </dd>
          {automation === undefined ? null : (
            <>
              <dt className="text-fg-muted">{t('button.automation.when')}</dt>
              <dd data-testid="button-enabled-when">
                {conditionText(
                  automation.definition.trigger.type === 'button.clicked'
                    ? automation.definition.trigger.enabled_when
                    : null,
                )}
              </dd>
              <dt className="text-fg-muted">{t('button.automation.steps')}</dt>
              <dd>
                {automation.definition.actions.length === 0
                  ? t('button.automation.noSteps')
                  : automation.definition.actions
                      .map((action) => t(`automationBuilder:actionType.${action.type}`))
                      .join(' · ')}
              </dd>
            </>
          )}
        </dl>
        {read ? (
          <div
            role="note"
            className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-label font-normal"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              {t('button.automation.readWarning', {
                name: automation?.run_as.name ?? t('button.automation.runAsUnknown'),
              })}
            </span>
          </div>
        ) : null}
        <p className="text-label font-normal text-fg-muted">
          {t('button.automation.editInBuilder')}
        </p>
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className="text-label text-fg">
        {t('button.automation.title')}
      </h3>
      {body}
      <p className="text-label font-normal text-fg-muted">{t('button.automation.one')}</p>
    </section>
  );
}
