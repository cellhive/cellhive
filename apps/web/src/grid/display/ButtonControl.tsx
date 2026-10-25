import { cn, Spinner } from '@cellhive/ui';
import { Zap } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import { BUTTON_BASE_CLASSES, BUTTON_DISABLED_CLASSES, buttonColors } from './ButtonValue';

import type { ButtonView } from '../../lib/buttons/model';

export interface ButtonControlProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'color' | 'disabled'
> {
  readonly label: string;
  readonly color: number;
  readonly view: ButtonView;
  /** `lg`: 44 px, full width (phones, board "S5 · Button field - 375 px"). */
  readonly size?: 'md' | 'lg';
}

/**
 * An interactive button cell (record panel). Disabled and running stay
 * focusable (`aria-disabled`) so the reason's tooltip is reachable by
 * keyboard; the click handler is only called when ready.
 */
export const ButtonControl = forwardRef<HTMLButtonElement, ButtonControlProps>(
  function ButtonControl({ label, color, view, size = 'md', className, onClick, ...rest }, ref) {
    const { t } = useTranslation('grid');
    const ready = view.state === 'ready';
    return (
      <button
        ref={ref}
        type="button"
        aria-disabled={ready ? undefined : true}
        aria-busy={view.state === 'running' ? true : undefined}
        className={cn(
          BUTTON_BASE_CLASSES,
          size === 'lg'
            ? 'h-11 w-full px-3 text-[15px]'
            : 'min-h-control px-2.5 text-label lg:h-7 lg:min-h-0',
          ready ? 'cursor-pointer hover:brightness-95' : 'cursor-not-allowed',
          view.state === 'disabled' && BUTTON_DISABLED_CLASSES,
          className,
        )}
        style={buttonColors(color, view)}
        onClick={(event) => {
          if (!ready) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        {...rest}
      >
        {view.state === 'running' ? (
          <Spinner className="size-3.5" />
        ) : (
          <Zap aria-hidden="true" className={size === 'lg' ? 'size-4' : 'size-3.5'} />
        )}
        <span className="truncate">{view.state === 'running' ? t('button.running') : label}</span>
      </button>
    );
  },
);
