import { Button, Dialog, Spinner, Switch } from '@cellhive/ui';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { showErrorToast } from '../../../../lib/toast/toast';
import { useUpdateEmailSettings } from '../api';

import { NoteBox, SettingsSection } from './SettingsSection';

import type { EmailSettingsDto } from '@cellhive/contracts';

/**
 * "System sender for automations" (CONTRACTS §23.4): a switch that takes
 * effect at once. Turning it off while automations send with it first asks
 * for confirmation, with how many (and how many are on) will fail.
 */
export function SystemSenderSection({
  orgId,
  settings,
}: {
  readonly orgId: string;
  readonly settings: EmailSettingsDto;
}) {
  const { t } = useTranslation('emailSettings');
  const id = useId();
  const save = useUpdateEmailSettings(orgId);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const { automation, smtp } = settings;
  const usage = automation.system_sender_usage;
  const from =
    smtp.from === null
      ? null
      : smtp.from_name === null || smtp.from_name === ''
        ? smtp.from
        : `${smtp.from_name} <${smtp.from}>`;

  const apply = (enabled: boolean) => {
    setSaved(null);
    save.mutate(
      { system_sender_enabled: enabled },
      {
        onSuccess: (next) => {
          setConfirming(false);
          setSaved(
            next.automation.system_sender_enabled
              ? t('systemSender.savedOn')
              : t('systemSender.savedOff'),
          );
        },
        onError: (error) => {
          setConfirming(false);
          showErrorToast(error);
        },
      },
    );
  };

  return (
    <SettingsSection data-testid="system-sender" title={t('systemSender.title')}>
      <div className="flex items-start gap-3">
        <span className="flex min-h-control items-center lg:min-h-0 lg:pt-0.5">
          <Switch
            id={`${id}-switch`}
            data-testid="system-sender-switch"
            checked={automation.system_sender_enabled}
            disabled={save.isPending}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              if (event.target.checked) {
                apply(true);
              } else if (usage.automations > 0) {
                setConfirming(true);
              } else {
                apply(false);
              }
            }}
          />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={`${id}-switch`} className="cursor-pointer text-body font-medium">
            {from === null ? t('systemSender.labelNoSmtp') : t('systemSender.label', { from })}
          </label>
          <span id={`${id}-hint`} className="text-label font-normal text-fg-muted">
            {t('systemSender.hint')}{' '}
            <span data-testid="system-sender-usage">
              {usage.automations === 0
                ? t('systemSender.usageNone')
                : t('systemSender.usage', {
                    count: usage.automations,
                    enabled: usage.enabled_automations,
                  })}
            </span>
          </span>
        </span>
      </div>
      <div role="status" aria-live="polite" data-testid="system-sender-saved">
        {saved === null ? null : (
          <p className="inline-flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-body text-fg">
            <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-accent" />
            {saved}
          </p>
        )}
      </div>
      <Dialog
        open={confirming}
        role="alertdialog"
        layout="sheet"
        className="max-w-[520px]"
        title={t('systemSender.dialog.title')}
        closeLabel={t('systemSender.dialog.cancel')}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setConfirming(false);
        }}
      >
        <div className="flex flex-col gap-4" data-testid="system-sender-dialog">
          <NoteBox tone="warning" icon={<TriangleAlert />}>
            {t('systemSender.dialog.body', {
              count: usage.automations,
              enabled: usage.enabled_automations,
            })}
          </NoteBox>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('systemSender.dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="system-sender-confirm"
              disabled={save.isPending}
              onClick={() => {
                apply(false);
              }}
            >
              {save.isPending ? <Spinner /> : null}
              {t('systemSender.dialog.confirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </SettingsSection>
  );
}
