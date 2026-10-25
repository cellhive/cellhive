import { Button, cn, Spinner, Tooltip } from '@cellhive/ui';
import { Palette } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TOOLBAR_LABEL } from '../../../lib/views/toolbar';
import { ToolbarPopover } from '../../../lib/views/ToolbarPopover';

import type { ViewToolbarProps } from '../../../lib/views/toolbar';

/** The rule list and its condition builders: loaded when the panel first opens. */
const ColorRulesPanel = lazy(() => import('./ColorRulesPanel'));

/**
 * "Color" of a grid view's toolbar (T816, FRONTEND §6.9): the view's color
 * rules — the first enabled rule whose conditions a record matches colors
 * its row or one cell. Saved with the view (not temporary: the server
 * colors the records with the saved rules) by those who may save it.
 */
export function ColorRulesButton(props: ViewToolbarProps) {
  const { t } = useTranslation('toolbar');
  const [open, setOpen] = useState(false);
  const count = (props.state.config.color_rules ?? []).filter((rule) => rule.enabled).length;
  const label = count > 0 ? t('colorRules.buttonCount', { count }) : t('colorRules.button');
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={setOpen}
      label={t('colorRules.title')}
      className="md:w-[40rem]"
      trigger={(trigger) => (
        // The label is hidden below 1280 px: then the tooltip says it.
        <Tooltip content={label} className="xl:hidden">
          <Button
            {...trigger}
            variant="ghost"
            size="toolbar"
            aria-label={label}
            className={cn(
              'shrink-0',
              count > 0 && 'bg-accent-soft text-accent hover:bg-accent-soft',
            )}
            data-testid="color-rules-button"
          >
            <Palette aria-hidden="true" />
            <span aria-hidden="true" className={TOOLBAR_LABEL}>
              {label}
            </span>
          </Button>
        </Tooltip>
      )}
    >
      <Suspense
        fallback={
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        }
      >
        <ColorRulesPanel {...props} />
      </Suspense>
    </ToolbarPopover>
  );
}
