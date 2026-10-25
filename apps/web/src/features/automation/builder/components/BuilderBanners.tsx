import { Button, Dialog, Spinner } from '@cellhive/ui';
import { CircleAlert, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { automationScope } from '../../list/model/scope';
import { stepOrder, type BuilderIssue, type StepKey } from '../model/issues';

import { useBuilderEnv } from './env';
import { useIssueText } from './issue-text';

import type { AutomationDefinition, AutomationDto } from '@cellhive/contracts';

/**
 * The `run_as` band (ADR-25 §4, board "S5 · Automation builder"): shown
 * when the person editing is not who the automation runs as — after saving
 * a change of trigger, condition or steps (or turning it on) it runs with
 * the editor's permissions instead. "Permissions used" lists what the
 * definition reads and writes.
 */
export function RunAsBanner({
  automation,
  definition,
  definitionChanged,
}: {
  readonly automation: AutomationDto;
  readonly definition: AutomationDefinition;
  readonly definitionChanged: boolean;
}) {
  const { t } = useTranslation(['automationBuilder', 'automation']);
  const env = useBuilderEnv();
  const [open, setOpen] = useState(false);
  const scope = automationScope(definition);
  const table = (id: string) => env.tableName(id) ?? t('automation:trigger.unknownTable');
  const field = (tableId: string, id: string) =>
    env.fieldsOf(tableId)?.find((item) => item.id === id)?.name ??
    t('automation:trigger.unknownField');
  const reads =
    scope.reads.length === 0 ? t('automation:takeOver.nothing') : scope.reads.map(table).join(', ');
  const writes =
    scope.writes.length === 0
      ? t('automation:takeOver.nothing')
      : scope.writes
          .map((write) => {
            const parts = [
              ...(write.fields.length > 0
                ? [write.fields.map((id) => field(write.tableId, id)).join(', ')]
                : []),
              ...(write.add ? [t('automation:takeOver.add')] : []),
              ...(write.delete ? [t('automation:takeOver.delete')] : []),
            ];
            return parts.length === 0
              ? table(write.tableId)
              : t('automation:takeOver.writeFields', {
                  table: table(write.tableId),
                  fields: parts.join('; '),
                });
          })
          .join(', ');
  return (
    <div
      role="note"
      data-testid="run-as-banner"
      className="flex flex-col gap-1 border-b border-warning/40 bg-option-3 px-4 py-2 text-label font-normal text-fg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <UserRound aria-hidden="true" className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          {t('runAs.current', { user: automation.run_as.name })}{' '}
          <strong className="font-semibold">
            {definitionChanged
              ? t('runAs.afterSave', { user: automation.run_as.name })
              : t('runAs.ifChanged', { user: automation.run_as.name })}
          </strong>
        </span>
        <Button
          variant="link"
          size="sm"
          className="max-lg:min-h-control"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {t('runAs.permissions')}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-0.5 pl-6" data-testid="run-as-scope">
          <span>{t('automation:takeOver.reads', { tables: reads })}</span>
          <span>{t('automation:takeOver.writes', { tables: writes })}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Not saved: N problems" (board "S5 · Automation builder - action"): one
 * line per problem with its card ("Step 3: …"), and "Go to the first
 * problem", which opens that card and moves the focus there.
 */
export function IssueSummary({
  issues,
  definition,
  stepLabel,
  onGoTo,
}: {
  readonly issues: readonly BuilderIssue[];
  readonly definition: AutomationDefinition;
  readonly stepLabel: (step: StepKey) => string;
  readonly onGoTo: (step: StepKey) => void;
}) {
  const { t } = useTranslation('automationBuilder');
  const text = useIssueText();
  const order = stepOrder(definition);
  const sorted = [...issues].sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
  const first = sorted[0];
  if (first === undefined) return null;
  return (
    <div
      role="alert"
      data-testid="issue-summary"
      className="mx-auto mb-4 flex w-full max-w-[600px] gap-2.5 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5 text-label font-normal text-fg"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <strong className="font-semibold">{t('issues.title', { count: issues.length })}</strong>
        <ul className="flex flex-col gap-0.5">
          {sorted.slice(0, 8).map((issue, index) => (
            <li key={`${issue.step}-${issue.path}-${String(index)}`}>
              {stepLabel(issue.step)}: {text(issue)}
            </li>
          ))}
          {sorted.length > 8 ? <li>{t('summary.more', { count: sorted.length - 8 })}</li> : null}
        </ul>
        <div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-1 max-lg:h-control"
            onClick={() => {
              onGoTo(first.step);
            }}
          >
            {t('issues.goTo')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * `409 VERSION_CONFLICT` on save (CONTRACTS §21): someone changed the
 * automation meanwhile. Load theirs (the draft is dropped) or save mine
 * over it (with the version now current).
 */
export function ConflictDialog({
  by,
  pending,
  onReload,
  onOverwrite,
  onCancel,
}: {
  readonly by: string | null;
  readonly pending: boolean;
  readonly onReload: () => void;
  readonly onOverwrite: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation('automationBuilder');
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t('conflict.title')}
      description={by === null ? t('conflict.bodyUnknown') : t('conflict.body', { user: by })}
      closeLabel={t('conflict.cancel')}
      className="max-w-[520px]"
      layout="sheet"
    >
      <div className="flex flex-wrap justify-end gap-2" data-testid="conflict-dialog">
        <Button variant="secondary" disabled={pending} onClick={onReload}>
          {t('conflict.reload')}
        </Button>
        <Button disabled={pending} onClick={onOverwrite} data-testid="conflict-overwrite">
          {pending ? <Spinner /> : null}
          {t('conflict.overwrite')}
        </Button>
      </div>
    </Dialog>
  );
}

/** Leaving with unsaved changes (route change or tab close) asks first. */
export function LeaveDialog({
  onStay,
  onLeave,
}: {
  readonly onStay: () => void;
  readonly onLeave: () => void;
}) {
  const { t } = useTranslation('automationBuilder');
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
      title={t('leave.title')}
      description={t('leave.body')}
      closeLabel={t('leave.stay')}
      className="max-w-[480px]"
      layout="sheet"
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onStay}>
          {t('leave.stay')}
        </Button>
        <Button variant="danger" onClick={onLeave} data-testid="leave-confirm">
          {t('leave.leave')}
        </Button>
      </div>
    </Dialog>
  );
}

/** Deleting an `if` that has steps in its branches asks first (they go with it). */
export function DeleteStepDialog({
  title,
  count,
  onCancel,
  onConfirm,
}: {
  readonly title: string;
  readonly count: number;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation('automationBuilder');
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('deleteStep.title', { title })}
      description={t('deleteStep.body', { count })}
      closeLabel={t('deleteStep.cancel')}
      className="max-w-[480px]"
      layout="sheet"
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {t('deleteStep.cancel')}
        </Button>
        <Button variant="danger" onClick={onConfirm} data-testid="delete-step-confirm">
          {t('deleteStep.confirm')}
        </Button>
      </div>
    </Dialog>
  );
}
