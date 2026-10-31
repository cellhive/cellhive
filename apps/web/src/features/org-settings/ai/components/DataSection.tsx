import { Button, Dialog, Spinner, Switch } from '@cellhive/ui';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { showToast } from '../../../../lib/toast/toast';
import { SettingsSection } from '../../email/components/SettingsSection';
import { useUpdateAiSettings } from '../api';
import { displayHostOf } from '../model';

import type { AiSettingsDto } from '@cellhive/contracts';
import type { ReactNode } from 'react';

/** A switch row that applies at once (F§9.2): label, the line under it, the switch. */
function SwitchRow({
  label,
  hint,
  pending,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly pending: boolean;
  readonly children: (ids: { id: string; hintId: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-4 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="flex items-center gap-2 text-body font-medium text-fg">
          {label}
          {pending ? <Spinner className="size-3.5 text-fg-muted" /> : null}
        </label>
        <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
          {hint}
        </p>
      </div>
      {children({ id, hintId: `${id}-hint` })}
    </div>
  );
}

/**
 * What AI may see and what the audit log keeps (CONTRACTS §29.1). Both
 * switches apply at once; letting AI see record values asks first, naming
 * the host that receives them and the features that send them
 * (`confirm: true`, else `RECORD_DATA_NOT_CONFIRMED`).
 */
export function DataSection({
  orgId,
  settings,
}: {
  readonly orgId: string;
  readonly settings: AiSettingsDto;
}) {
  const { t } = useTranslation('orgAi');
  const recordData = useUpdateAiSettings(orgId);
  const logPrompts = useUpdateAiSettings(orgId);
  const [confirming, setConfirming] = useState(false);
  const host = displayHostOf(settings.provider_base_url);
  const setRecordData = (on: boolean) => {
    recordData.mutate(
      on ? { allow_record_data: true, confirm: true } : { allow_record_data: false },
      {
        onSuccess: () => {
          setConfirming(false);
          showToast({ variant: 'success', message: t(on ? 'data.on' : 'data.off') });
        },
      },
    );
  };

  return (
    <SettingsSection
      data-testid="ai-data"
      title={t('data.title')}
      description={t('data.description')}
    >
      <SwitchRow
        label={t('data.recordData')}
        hint={
          host === null
            ? t('data.needsProvider')
            : settings.allow_record_data
              ? t('data.recordDataOn', { host })
              : t('data.recordDataOff')
        }
        pending={recordData.isPending && !confirming}
      >
        {({ id, hintId }) => (
          <Switch
            id={id}
            aria-describedby={hintId}
            data-testid="ai-record-data"
            checked={settings.allow_record_data}
            disabled={recordData.isPending || (host === null && !settings.allow_record_data)}
            onChange={(event) => {
              if (event.currentTarget.checked) setConfirming(true);
              else setRecordData(false);
            }}
          />
        )}
      </SwitchRow>
      {recordData.isError && !confirming ? <ErrorAlert error={recordData.error} /> : null}
      <SwitchRow
        label={t('data.logPrompts')}
        hint={t('data.logPromptsHint')}
        pending={logPrompts.isPending}
      >
        {({ id, hintId }) => (
          <Switch
            id={id}
            aria-describedby={hintId}
            data-testid="ai-log-prompts"
            checked={settings.log_prompts}
            disabled={logPrompts.isPending}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              logPrompts.mutate(
                { log_prompts: on },
                {
                  onSuccess: () => {
                    showToast({
                      variant: 'success',
                      message: t(on ? 'data.logOn' : 'data.logOff'),
                    });
                  },
                },
              );
            }}
          />
        )}
      </SwitchRow>
      {logPrompts.isError ? <ErrorAlert error={logPrompts.error} /> : null}
      {confirming && host !== null ? (
        <Dialog
          open
          role="alertdialog"
          layout="sheet"
          className="max-w-lg"
          onOpenChange={(next) => {
            if (!next && !recordData.isPending) {
              setConfirming(false);
              recordData.reset();
            }
          }}
          title={t('data.dialog.title')}
          closeLabel={t('close')}
        >
          <div className="flex flex-col gap-4" data-testid="ai-record-data-dialog">
            <div className="flex flex-col gap-2 text-body text-fg">
              <p>
                <Trans
                  t={t}
                  i18nKey="data.dialog.lead"
                  values={{ host }}
                  components={{ strong: <strong className="font-mono font-semibold" /> }}
                />
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                <li>{t('data.dialog.fields')}</li>
                <li>{t('data.dialog.actions')}</li>
                <li>{t('data.dialog.ask')}</li>
              </ul>
              <p className="text-label font-normal text-fg-muted">{t('data.dialog.never')}</p>
            </div>
            {recordData.isError ? <ErrorAlert error={recordData.error} /> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                disabled={recordData.isPending}
                onClick={() => {
                  setConfirming(false);
                  recordData.reset();
                }}
              >
                {t('cancel')}
              </Button>
              <Button
                disabled={recordData.isPending}
                data-testid="ai-record-data-confirm"
                onClick={() => {
                  setRecordData(true);
                }}
              >
                {recordData.isPending ? <Spinner /> : null}
                {t('data.dialog.confirm')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </SettingsSection>
  );
}
