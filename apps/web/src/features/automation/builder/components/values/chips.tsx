import { cn } from '@cellhive/ui';
import { AlertTriangle, Braces, Clock, Database, Hash, Layers, Webhook } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChipName, ChipTone } from '../../model/scope';

/** Chip colors (board "S5 · Automation builder"): data colors with ≥ 4.5:1 text (FRONTEND §9.3). */
export const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  field: 'bg-option-5 text-on-option-5 border-option-5',
  trigger: 'bg-option-7 text-on-option-7 border-option-7',
  step: 'bg-option-3 text-on-option-3 border-option-3',
  expression: 'bg-option-1 text-on-option-1 border-option-1',
  error: 'border-dashed border-danger bg-danger/10 text-danger',
};

export const CHIP_CLASS =
  'inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-1.5 align-middle text-label font-medium whitespace-nowrap';

const ICONS: Record<ChipTone, typeof Hash> = {
  field: Hash,
  trigger: Clock,
  step: Layers,
  expression: Braces,
  error: AlertTriangle,
};

/** Translation key of a step part (`{ step, path }` or `[act_…].[@…]`). */
const PART_KEYS: Readonly<Record<string, string>> = {
  id: 'id',
  'records[0].id': 'firstId',
  count: 'count',
  record: 'record',
  '@url': 'url',
  '@id': 'id',
  output: 'output',
};

/** Text of a chip, translated (`#REF` for what no longer exists). */
export function useChipText(): (name: ChipName) => string {
  const { t } = useTranslation('automationBuilder');
  return useCallback(
    (name: ChipName) => {
      switch (name.tone) {
        case 'field':
          return name.field;
        case 'trigger':
          if ('data' in name) return t(`chip.trigger.${name.data}` as 'chip.trigger.fired_at');
          if ('previous' in name) return t('chip.previous', { field: name.previous });
          if ('webhook' in name) return name.webhook;
          return t(`chip.record.${name.record.slice(1)}` as 'chip.record.id');
        case 'step':
          return name.field === undefined
            ? t('chip.stepPart', {
                number: name.number,
                part:
                  PART_KEYS[name.part ?? 'output'] === undefined
                    ? (name.part ?? '')
                    : t(
                        `chip.part.${PART_KEYS[name.part ?? 'output'] ?? 'output'}` as 'chip.part.id',
                      ),
              })
            : t('chip.stepField', { number: name.number, field: name.field });
        case 'expression':
          return name.expression;
        case 'error':
          return t('chip.ref');
      }
    },
    [t],
  );
}

/** A chip as a React element (summaries, single values). */
export function Chip({
  name,
  className,
  children,
}: {
  readonly name: ChipName;
  readonly className?: string;
  readonly children?: React.ReactNode;
}) {
  const text = useChipText()(name);
  const { t } = useTranslation('automationBuilder');
  const Icon =
    name.tone === 'trigger' && 'record' in name
      ? Database
      : name.tone === 'trigger' && 'webhook' in name
        ? Webhook
        : ICONS[name.tone];
  return (
    <span
      className={cn(CHIP_CLASS, CHIP_TONE_CLASS[name.tone], className)}
      title={name.tone === 'error' ? t('chip.refHint') : undefined}
      data-chip-tone={name.tone}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
      {children}
    </span>
  );
}
