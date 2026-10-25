import { Checkbox } from '@cellhive/ui';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import type { BaseRule } from '@cellhive/permissions';

const RULES = ['copy', 'download', 'share_link'] as const satisfies readonly (keyof BaseRule)[];

/**
 * General permissions of the role (`base_rule`, SPEC §14.1): copy,
 * download/export, share links — each with what it lets people do. Check
 * boxes: the values wait for "Save" (a switch would take effect at once).
 */
export function BaseRuleSection({
  value,
  disabled,
  onChange,
}: {
  readonly value: BaseRule;
  readonly disabled: boolean;
  readonly onChange: (value: BaseRule) => void;
}) {
  const { t } = useTranslation('baseSettings');
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
      data-testid="base-rule"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-body font-semibold text-fg">
          {t('editor.baseRule.title')}
        </h2>
        <p className="text-label font-normal text-fg-muted">{t('editor.baseRule.description')}</p>
      </div>
      <fieldset className="grid gap-3 md:grid-cols-3" disabled={disabled}>
        <legend className="sr-only">{t('editor.baseRule.title')}</legend>
        {RULES.map((rule) => (
          <Checkbox
            key={rule}
            label={t(`editor.baseRule.${rule}.label`)}
            hint={t(`editor.baseRule.${rule}.hint`)}
            checked={value[rule]}
            data-testid={`base-rule-${rule}`}
            onChange={(event) => {
              onChange({ ...value, [rule]: event.currentTarget.checked });
            }}
          />
        ))}
      </fieldset>
    </section>
  );
}
