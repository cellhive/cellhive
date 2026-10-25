import {
  AUTOMATION_TRIGGER_TYPES,
  type AutomationTriggerType,
  type BaseDetail,
} from '@cellhive/contracts';
import { Button, cn, Dialog, FormField, Input } from '@cellhive/ui';
import { ArrowRight } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isBaseAdmin } from '../../../../lib/permissions/access';
import { TRIGGER_ICONS } from '../../trigger-icons';

/** Why a trigger type cannot be picked here (`null`: it can). Both are base admins only. */
function unavailable(type: AutomationTriggerType, base: BaseDetail): 'schedule' | 'webhook' | null {
  if (type === 'schedule' && !isBaseAdmin(base.access)) return 'schedule';
  if (type === 'webhook.received' && !isBaseAdmin(base.access)) return 'webhook';
  return null;
}

/** What the builder of a new automation starts with. */
export interface NewAutomationStart {
  readonly name: string;
  readonly trigger: AutomationTriggerType;
}

export interface CreateAutomationDialogProps {
  readonly base: BaseDetail;
  readonly onCancel: () => void;
  readonly onContinue: (start: NewAutomationStart) => void;
}

/**
 * "Create automation" (board "S5 · Automation list - trạng thái"): a name
 * and the kind of trigger, then "Continue" opens the builder (T521), which
 * creates the automation — off — when it is first saved (reviewer decision:
 * nothing is created before). `schedule` and `webhook.received` (T612) are
 * for base admins only; the
 * builder asks the button of a `button.clicked` trigger (T525).
 */
export function CreateAutomationDialog({
  base,
  onCancel,
  onContinue,
}: CreateAutomationDialogProps) {
  const { t } = useTranslation('automation');
  const groupId = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<AutomationTriggerType>('record.created');
  const [touched, setTouched] = useState(false);
  const nameError = touched && name.trim() === '' ? t('create.nameRequired') : undefined;

  const submit = () => {
    setTouched(true);
    if (name.trim() === '' || unavailable(type, base) !== null) return;
    onContinue({ name: name.trim(), trigger: type });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('create.title')}
      closeLabel={t('create.cancel')}
      className="max-w-[560px]"
      layout="sheet"
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        data-testid="create-automation-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormField label={t('create.name')} error={nameError}>
          {(control) => (
            <Input
              {...control}
              value={name}
              maxLength={255}
              autoComplete="off"
              data-testid="create-automation-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </FormField>
        <fieldset className="flex min-w-0 flex-col gap-1.5">
          <legend id={groupId} className="mb-1.5 text-label text-fg">
            {t('create.trigger')}
          </legend>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {AUTOMATION_TRIGGER_TYPES.map((value) => {
              const Icon = TRIGGER_ICONS[value];
              const reason = unavailable(value, base);
              const reasonId = `${groupId}-${value}`;
              return (
                <label
                  key={value}
                  className={cn(
                    'flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 text-body text-fg max-lg:min-h-control',
                    'has-[:checked]:border-accent has-[:checked]:bg-accent-soft',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
                    reason !== null && 'cursor-not-allowed text-fg-muted',
                  )}
                >
                  <input
                    type="radio"
                    name={groupId}
                    value={value}
                    checked={type === value}
                    disabled={reason !== null}
                    aria-describedby={reason === null ? undefined : reasonId}
                    className="sr-only"
                    data-testid={`trigger-${value}`}
                    onChange={() => {
                      setType(value);
                    }}
                  />
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      'size-4 shrink-0',
                      type === value ? 'text-accent' : 'text-fg-muted',
                    )}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span>{t(`trigger.type.${value}`)}</span>
                    {reason === null ? null : (
                      <span id={reasonId} className="text-label font-normal text-fg-muted">
                        {t(`create.unavailable.${reason}`)}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 basis-56 text-label font-normal text-fg-muted">
            {t('create.note')}
          </span>
          <Button variant="secondary" onClick={onCancel}>
            {t('create.cancel')}
          </Button>
          <Button type="submit" data-testid="create-automation-submit">
            {t('create.continue')}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
