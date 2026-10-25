import { cn } from '@cellhive/ui';
import { Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ButtonView } from '../../lib/buttons/model';

/**
 * The look of a button cell in the DOM (T525, Quyết định S5 thiết kế #6):
 * a light background of the label palette with its dark text (≥ 4.5:1,
 * FRONTEND §9.3), grey when disabled, "Running…" with a spinner while a
 * click runs. Glide-free and small: cards, previews and share pages use it
 * (the interactive one is `ButtonControl.tsx`).
 */

/** Inline colors of a palette index (CSSOM: allowed by the CSP, FRONTEND §9.3). */
export function buttonColors(color: number, view: ButtonView): React.CSSProperties | undefined {
  if (view.state === 'disabled') return undefined;
  const index = String(((color % 8) + 8) % 8);
  return {
    backgroundColor: `var(--option-${index}-bg)`,
    color: `var(--option-${index}-fg)`,
    borderColor: `color-mix(in srgb, var(--option-${index}-fg) 28%, transparent)`,
  };
}

export const BUTTON_BASE_CLASSES =
  'inline-flex max-w-full min-w-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap';
export const BUTTON_DISABLED_CLASSES = 'border-line bg-surface-sunken text-fg-subtle';

export interface ButtonPillProps {
  readonly label: string;
  readonly color: number;
  readonly view: ButtonView;
  readonly className?: string;
}

/** A non-interactive button cell (cards, sub-tables, history, share pages). */
export function ButtonPill({ label, color, view, className }: ButtonPillProps) {
  const { t } = useTranslation('grid');
  return (
    <span
      className={cn(
        BUTTON_BASE_CLASSES,
        'h-6 px-2 text-label',
        view.state === 'disabled' && BUTTON_DISABLED_CLASSES,
        className,
      )}
      style={buttonColors(color, view)}
    >
      <Zap aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
      {view.state === 'disabled' ? (
        <span className="sr-only">{t('button.disabledState')}</span>
      ) : null}
    </span>
  );
}
