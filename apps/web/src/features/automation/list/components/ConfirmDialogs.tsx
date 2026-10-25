import { Button, Checkbox, Dialog, Spinner } from '@cellhive/ui';
import { useQueries } from '@tanstack/react-query';
import { Trash2, TriangleAlert, UserCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { fieldsQuery } from '../../../../lib/query/queries';
import { automationScope } from '../model/scope';

import type { AutomationDto } from '@cellhive/contracts';

interface ConfirmProps {
  readonly automation: AutomationDto;
  readonly pending: boolean;
  readonly onCancel: () => void;
}

function Footer({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 pt-1">{children}</div>;
}

/**
 * "Turn on automation?" (ADR-25 §4, board "S5 · Automation list - trạng
 * thái"): asked when the person turning it on is not its `run_as` — once
 * on, it runs with their permissions instead.
 */
export function EnableDialog({
  automation,
  baseName,
  pending,
  onCancel,
  onConfirm,
}: ConfirmProps & { readonly baseName: string; readonly onConfirm: () => void }) {
  const { t } = useTranslation('automation');
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t('enable.title')}
      closeLabel={t('enable.cancel')}
      className="max-w-[520px]"
      layout="sheet"
    >
      <div className="flex flex-col gap-3" data-testid="enable-automation-dialog">
        <p className="text-body text-fg">
          <Trans
            t={t}
            i18nKey="enable.runsAs"
            values={{ name: automation.name, user: automation.run_as.name }}
            components={{ strong: <strong className="font-semibold" /> }}
          />
        </p>
        <div
          role="note"
          className="flex gap-2.5 rounded-lg border border-warning/50 bg-option-3 px-3 py-2.5 text-label font-normal text-fg"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <strong className="font-semibold">
              {t('enable.warning', { user: automation.run_as.name })}
            </strong>
            <span>{t('enable.detail', { base: baseName })}</span>
          </div>
        </div>
        <Footer>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {t('enable.cancel')}
          </Button>
          <Button disabled={pending} onClick={onConfirm} data-testid="enable-automation-confirm">
            {pending ? <Spinner /> : null}
            {t('enable.confirm')}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

export interface TakeOverDialogProps extends ConfirmProps {
  /** Table names the caller sees (tables of the base). */
  readonly tableName: (tableId: string) => string | undefined;
  readonly onConfirm: (enable: boolean) => void;
}

/**
 * "Take over" (ADR-25 §6): the caller becomes `run_as`; the dialog says
 * what the automation reads and writes — the permissions it will use — and
 * whether to turn it back on at once (on by default when the system turned
 * it off because its `run_as` lost access).
 */
export function TakeOverDialog({
  automation,
  tableName,
  pending,
  onCancel,
  onConfirm,
}: TakeOverDialogProps) {
  const { t } = useTranslation('automation');
  const [enable, setEnable] = useState(
    automation.enabled || automation.disabled_reason === 'run_as_lost_access',
  );
  const scope = automationScope(automation.definition);
  const fieldLists = useQueries({
    queries: scope.writes.map((write) => fieldsQuery(write.tableId)),
  });
  const table = (tableId: string) => tableName(tableId) ?? t('trigger.unknownTable');
  const reads =
    scope.reads.length === 0 ? t('takeOver.nothing') : scope.reads.map(table).join(', ');
  const writes =
    scope.writes.length === 0
      ? t('takeOver.nothing')
      : scope.writes
          .map((write, index) => {
            const fields = fieldLists[index]?.data?.items ?? [];
            const names = write.fields.map(
              (fieldId) =>
                fields.find((field) => field.id === fieldId)?.name ?? t('trigger.unknownField'),
            );
            const parts = [
              ...(names.length > 0 ? [names.join(', ')] : []),
              ...(write.add ? [t('takeOver.add')] : []),
              ...(write.delete ? [t('takeOver.delete')] : []),
            ];
            return parts.length === 0
              ? table(write.tableId)
              : t('takeOver.writeFields', {
                  table: table(write.tableId),
                  fields: parts.join('; '),
                });
          })
          .join(', ');
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t('takeOver.title', { name: automation.name })}
      closeLabel={t('takeOver.cancel')}
      className="max-w-[520px]"
      layout="sheet"
    >
      <div className="flex flex-col gap-3" data-testid="take-over-dialog">
        <p className="text-body text-fg">
          {automation.disabled_reason === 'run_as_lost_access'
            ? t('takeOver.lost', { user: automation.run_as.name })
            : t('takeOver.runsAs', { user: automation.run_as.name })}
        </p>
        <div className="flex flex-col gap-1.5 rounded-lg bg-surface-sunken px-3 py-2.5 text-label font-normal text-fg">
          <span className="font-semibold">{t('takeOver.scope')}</span>
          <span data-testid="take-over-reads">{t('takeOver.reads', { tables: reads })}</span>
          <span data-testid="take-over-writes">{t('takeOver.writes', { tables: writes })}</span>
        </div>
        <Checkbox
          label={t('takeOver.enable')}
          checked={enable}
          onChange={(event) => {
            setEnable(event.target.checked);
          }}
        />
        <Footer>
          <Button variant="secondary" disabled={pending} onClick={onCancel}>
            {t('takeOver.cancel')}
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              onConfirm(enable);
            }}
            data-testid="take-over-confirm"
          >
            {pending ? <Spinner /> : <UserCheck aria-hidden="true" />}
            {t('takeOver.confirm')}
          </Button>
        </Footer>
      </div>
    </Dialog>
  );
}

/** Delete with confirmation (board "S5 · Automation list - trạng thái": "Xoá có xác nhận"). */
export function DeleteAutomationDialog({
  automation,
  pending,
  onCancel,
  onConfirm,
}: ConfirmProps & { readonly onConfirm: () => void }) {
  const { t } = useTranslation('automation');
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      title={t('delete.title', { name: automation.name })}
      description={t('delete.body')}
      closeLabel={t('delete.cancel')}
      className="max-w-[480px]"
      layout="sheet"
    >
      <Footer>
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          {t('delete.cancel')}
        </Button>
        <Button
          variant="danger"
          disabled={pending}
          onClick={onConfirm}
          data-testid="delete-automation-confirm"
        >
          {pending ? <Spinner /> : <Trash2 aria-hidden="true" />}
          {t('delete.confirm')}
        </Button>
      </Footer>
    </Dialog>
  );
}
