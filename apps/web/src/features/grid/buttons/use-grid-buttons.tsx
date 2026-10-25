import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useButtonClicks } from '../../../lib/buttons/use-button-clicks';

import type { GridField, GridInteractionHooks } from '../../../grid';
import type { RecordDto } from '@cellhive/contracts';

export interface UseGridButtonsOptions {
  readonly tableId: string;
  readonly baseId: string;
  readonly fields: readonly GridField[];
  /** The user manages automations of the table: toasts link to the run. */
  readonly canSeeRuns: boolean;
  /** The record's title for the toasts. */
  readonly recordTitle: (record: RecordDto) => string;
}

/**
 * (T525) Button cells of the grid: `hooks.buttons` for `GridView` (press,
 * running cells, why a cell is disabled) and the confirmation dialog to
 * render next to it. Without button fields nothing is subscribed beyond the
 * `user:` channel the shell already holds.
 */
export function useGridButtons({
  tableId,
  baseId,
  fields,
  canSeeRuns,
  recordTitle,
}: UseGridButtonsOptions): { hooks: GridInteractionHooks; dialog: ReactNode } {
  const { t } = useTranslation('grid');
  const buttonFields = useMemo(
    () => fields.filter((field) => field.button !== undefined),
    [fields],
  );
  const buttonFieldIds = useMemo(() => buttonFields.map((field) => field.field.id), [buttonFields]);
  const clicks = useButtonClicks({ tableId, baseId, buttonFieldIds, canSeeRuns });
  const { press, running } = clicks;
  const runningKeys = useMemo(() => new Set(running.keys()), [running]);
  // The title function changes every render of the page: read the latest one.
  const title = useRef(recordTitle);
  useEffect(() => {
    title.current = recordTitle;
  });
  const hooks = useMemo<GridInteractionHooks>(
    () =>
      buttonFields.length === 0
        ? {}
        : {
            buttons: {
              running: runningKeys,
              reasonText: (reason) => t(`button.reason.${reason}`),
              onPress: (cell, record) => {
                const field = buttonFields.find((item) => item.field.id === cell.fieldId);
                if (field?.button === undefined) return;
                press({
                  field: { id: field.field.id, name: field.field.name },
                  column: field.button,
                  record,
                  recordTitle: title.current(record),
                });
              },
            },
          },
    [buttonFields, runningKeys, press, t],
  );
  return { hooks, dialog: clicks.dialog };
}
