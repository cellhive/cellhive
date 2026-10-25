import { Alert, Button, cn, Select, Switch, Tooltip } from '@cellhive/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TreeIcon } from '../../../grid/tree/TreeIcon';
import { api } from '../../../lib/api';
import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { keys } from '../../../lib/query/keys';
import { TOOLBAR_LABEL } from '../../../lib/views/toolbar';
import { ToolbarPopover } from '../../../lib/views/ToolbarPopover';

import { treeButtonLabel } from './tree-label';

import type { EffectiveViewConfig } from '../../../lib/views/config';
import type { ViewToolbarProps } from '../../../lib/views/toolbar';
import type { ViewConfigState } from '../../../lib/views/use-view-config';
import type { FieldDto } from '@cellhive/contracts';

/** Levels of a tree (SPEC §5.7). */
const MAX_LEVELS = 10;

/** Whether the view shows a tree: turned on and the table has sub-records the user reads. */
export function isTreeShown(config: EffectiveViewConfig, fields: readonly FieldDto[]): boolean {
  return config.tree.enabled && fields.some((field) => field.type === 'parent');
}

/**
 * The group panel while the view is a tree (T417, CONTRACTS §15
 * `TREE_WITH_GROUP`): why it cannot group, and a way to switch to groups.
 */
export function TreeGroupNotice({ state }: { readonly state: ViewConfigState }) {
  const { t } = useTranslation('tree');
  return (
    <div className="flex max-w-80 flex-col items-start gap-3" data-testid="tree-group-notice">
      <p className="text-body text-fg-muted">{t('toolbar.groupOff')}</p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          state.change({ tree: { ...state.config.tree, enabled: false } }, { temporary: true });
        }}
      >
        {t('toolbar.turnOff')}
      </Button>
    </div>
  );
}

/**
 * "Tree" of the view toolbar (T417, board "Sub-records dạng cây": "Cây:
 * mở 3 cấp"). Shows the view as a sub-record tree (`config.tree.enabled`,
 * temporary until saved like filter/sort/group, T311), whether filtered
 * views keep the matches' ancestors (dimmed), and how many levels open by
 * default (this user, this device). A tree is never grouped (CONTRACTS
 * §15 `TREE_WITH_GROUP`): turning it on sets the group aside, and the group
 * button says why it is off. A table without sub-records offers to turn
 * them on (the `parent` field) to those who may change its schema.
 */
export function TreeButton({ view, fields, state, treeActions }: ViewToolbarProps) {
  const { t } = useTranslation('tree');
  const [open, setOpen] = useState(false);
  const levelsId = useId();
  const queryClient = useQueryClient();
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<unknown>(null);
  const parentField = fields.find((field) => field.type === 'parent');
  const tree = state.config.tree;
  const on = tree.enabled && parentField !== undefined;
  const grouped = state.config.group.length > 0;
  const levels = treeActions?.levels ?? 1;
  const label = treeButtonLabel(t, on, levels);

  const setTree = (enabled: boolean, showAncestors = tree.show_ancestors) => {
    // Tree and group exclude each other: the group waits aside (temporary change).
    state.change(
      {
        tree: { enabled, show_ancestors: showAncestors },
        ...(enabled && grouped ? { group: [] } : {}),
      },
      { temporary: true },
    );
  };

  const enable = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      await api.fields.create(view.table_id, {
        name: t('toolbar.parentFieldName'),
        type: 'parent',
      });
      await queryClient.invalidateQueries({ queryKey: keys.fields(view.table_id) });
      setTree(true);
    } catch (error) {
      setEnableError(error);
    } finally {
      setEnabling(false);
    }
  };

  return (
    <ToolbarPopover
      open={open}
      onOpenChange={setOpen}
      label={t('toolbar.title')}
      trigger={(props) => (
        // The label is hidden below 1280 px: then the tooltip says it.
        <Tooltip content={label} className="xl:hidden">
          <Button
            {...props}
            variant="ghost"
            size="toolbar"
            aria-label={label}
            className={cn('shrink-0', on && 'bg-accent-soft text-accent hover:bg-accent-soft')}
            data-testid="tree-button"
          >
            <TreeIcon />
            <span aria-hidden="true" className={TOOLBAR_LABEL}>
              {label}
            </span>
          </Button>
        </Tooltip>
      )}
    >
      <h2 className="text-heading">{t('toolbar.title')}</h2>
      {parentField === undefined ? (
        <div className="flex max-w-80 flex-col gap-3">
          <p className="text-body text-fg-muted">{t('toolbar.notEnabled')}</p>
          {treeActions?.canEnable === true ? (
            <Button
              className="self-start"
              disabled={enabling}
              onClick={() => {
                void enable();
              }}
              data-testid="tree-enable"
            >
              <TreeIcon />
              {t('toolbar.enable')}
            </Button>
          ) : (
            <p className="text-label font-normal text-fg-muted">{t('toolbar.askAdmin')}</p>
          )}
          {enableError === null ? null : <ErrorAlert error={enableError} />}
        </div>
      ) : (
        <div className="flex max-w-96 flex-col gap-4">
          <label className="flex min-h-control items-center justify-between gap-4">
            <span className="flex flex-col">
              <span className="text-body text-fg">{t('toolbar.show')}</span>
              <span className="text-label font-normal text-fg-muted">
                {t('toolbar.showHint', { field: parentField.name })}
              </span>
            </span>
            <Switch
              checked={on}
              data-testid="tree-toggle"
              onChange={(event) => {
                setTree(event.target.checked);
              }}
            />
          </label>
          {grouped && !on ? (
            <Alert variant="info" className="text-label">
              {t('toolbar.groupWarning')}
            </Alert>
          ) : null}
          {on ? (
            <>
              <label className="flex min-h-control items-center justify-between gap-4">
                <span className="flex flex-col">
                  <span className="text-body text-fg">{t('toolbar.ancestors')}</span>
                  <span className="text-label font-normal text-fg-muted">
                    {t('toolbar.ancestorsHint')}
                  </span>
                </span>
                <Switch
                  checked={tree.show_ancestors}
                  data-testid="tree-ancestors"
                  onChange={(event) => {
                    setTree(true, event.target.checked);
                  }}
                />
              </label>
              {treeActions === undefined ? null : (
                <div className="flex flex-col gap-2">
                  <label htmlFor={levelsId} className="text-body text-fg">
                    {t('toolbar.levels')}
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      id={levelsId}
                      className="w-48"
                      value={String(levels)}
                      data-testid="tree-levels"
                      onChange={(event) => {
                        treeActions.openLevels(Number(event.target.value));
                      }}
                    >
                      {Array.from({ length: MAX_LEVELS }, (_, index) => index + 1).map((count) => (
                        <option key={count} value={count}>
                          {t('toolbar.levelOption', { count })}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        treeActions.openLevels(1);
                      }}
                    >
                      <ChevronsDownUp aria-hidden="true" />
                      {t('toolbar.collapseAll')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        treeActions.openLevels(MAX_LEVELS);
                      }}
                    >
                      <ChevronsUpDown aria-hidden="true" />
                      {t('toolbar.expandAll')}
                    </Button>
                  </div>
                  <p className="text-label font-normal text-fg-muted">{t('toolbar.levelsHint')}</p>
                </div>
              )}
            </>
          ) : null}
          <p className="text-label font-normal text-fg-muted">{t('toolbar.temporaryHint')}</p>
        </div>
      )}
    </ToolbarPopover>
  );
}
