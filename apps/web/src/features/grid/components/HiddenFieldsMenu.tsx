import { Button, cn, Spinner, Tooltip } from '@cellhive/ui';
import { EyeOff } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TOOLBAR_LABEL } from '../../../lib/views/toolbar';
import { ToolbarPopover } from '../../../lib/views/ToolbarPopover';

import type { GridField } from '../../../grid';

// The list (search, drag to reorder with dnd-kit) loads when first opened.
const loadPanel = () => import('./HiddenFieldsPanel');
const HiddenFieldsPanel = lazy(loadPanel);

export interface HiddenFieldsMenuProps {
  /** Every field in the view's column order (the primary one first). */
  readonly fields: readonly GridField[];
  readonly hidden: readonly string[];
  readonly onToggle: (fieldId: string, visible: boolean) => void;
  readonly onSetAll: (hide: boolean) => void;
  /** Drag to reorder: `fieldId` takes the place of `targetFieldId` in the view's `field_order`. */
  readonly onMove: (fieldId: string, targetFieldId: string) => void;
}

/**
 * "Hide fields" / "N hidden fields" toolbar button (T207) and its panel
 * (T322b, Lark "Customize field"): every field with its type icon, a search
 * box, a switch per field (it applies at once), drag to reorder — the view's
 * `field_order`, through the view state (saved or unsaved like a column
 * drag) — and show all / hide all. The primary field always stays visible
 * and first.
 */
export function HiddenFieldsMenu({
  fields,
  hidden,
  onToggle,
  onSetAll,
  onMove,
}: HiddenFieldsMenuProps) {
  const { t } = useTranslation('grid');
  const [open, setOpen] = useState(false);
  const hiddenSet = new Set(hidden);
  const count = fields.filter((field) => hiddenSet.has(field.field.id)).length;
  const label = count > 0 ? t('hiddenFields.count', { count }) : t('hiddenFields.none');
  return (
    <ToolbarPopover
      open={open}
      onOpenChange={setOpen}
      label={t('hiddenFields.heading')}
      trigger={(props) => (
        // The label is hidden below 1280 px: then the tooltip says it.
        <Tooltip content={label} className="xl:hidden">
          <Button
            {...props}
            variant="ghost"
            size="toolbar"
            aria-label={label}
            className={cn(
              'shrink-0',
              count > 0 && 'bg-accent-soft text-accent hover:bg-accent-soft',
            )}
            data-testid="hidden-fields-button"
            onPointerEnter={() => {
              void loadPanel();
            }}
          >
            <EyeOff aria-hidden="true" />
            <span aria-hidden="true" className={TOOLBAR_LABEL}>
              {label}
            </span>
          </Button>
        </Tooltip>
      )}
    >
      <Suspense
        fallback={
          <div className="flex w-72 justify-center py-6">
            <Spinner />
          </div>
        }
      >
        <HiddenFieldsPanel
          fields={fields}
          hidden={hidden}
          onToggle={onToggle}
          onSetAll={onSetAll}
          onMove={onMove}
        />
      </Suspense>
    </ToolbarPopover>
  );
}
