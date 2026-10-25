import { useMemo } from 'react';

import { sharedFieldDtos } from '../fields';
import { initialChoices, type ViewerChoices } from '../query';

import type { SharePageParts } from '../../../../lib/share/public-page';
import type { EffectiveViewConfig } from '../../../../lib/views/config';
import type { ViewConfigState } from '../../../../lib/views/use-view-config';
import type { ShareMeta, ViewDto } from '@cellhive/contracts';

/** Types whose values are people: no member list to pick from through a link. */
/**
 * Fields a viewer cannot filter on: people (no member list outside the
 * organization) and records of other tables or of the tree (no record list
 * through a link; T409 filters links by id only).
 */
const UNPICKABLE_TYPES = new Set(['user', 'created_by', 'updated_by', 'link', 'parent']);

/** Whether the link lets the viewer filter/sort or search (else no toolbar at all). */
export function hasViewerTools(meta: ShareMeta): boolean {
  return meta.settings.allow_viewer_filter_sort || meta.settings.allow_search;
}

export interface ViewerToolsProps {
  readonly meta: ShareMeta;
  readonly parts: SharePageParts;
  readonly choices: ViewerChoices;
  readonly onChoices: (choices: ViewerChoices) => void;
  /** Error of the last record query (`422 INVALID_FILTER` marks conditions). */
  readonly error: unknown;
}

/**
 * The view toolbar of T311 (filter, sort, search) for a viewer of a link
 * (CONTRACTS §16A): filter and sort only with `allow_viewer_filter_sort`,
 * search only with `allow_search`; nothing is ever saved (changes stay on
 * this page). The filter narrows the view's own filter, which always
 * applies on the server and is never shown. People, link and parent fields
 * are not offered: a viewer outside the organization has no member or
 * record list to pick from.
 */
export function ViewerTools({ meta, parts, choices, onChoices, error }: ViewerToolsProps) {
  const { Controls, Search } = parts.Toolbar;
  const fields = useMemo(
    () => sharedFieldDtos(meta).filter((field) => !UNPICKABLE_TYPES.has(field.type)),
    [meta],
  );
  const searchFields = useMemo(() => sharedFieldDtos(meta), [meta]);
  const view = useMemo<ViewDto>(() => {
    // The rules of a shared view come without their filter (T816): the server colors.
    const { color_rules: rules = [], ...config } = meta.view.config;
    return {
      id: meta.view.id,
      table_id: meta.table.id,
      type: meta.view.type,
      name: meta.view.name,
      is_personal: false,
      owner_id: null,
      position: 0,
      locked: true,
      config: {
        ...config,
        filter: null,
        color_rules: rules.map((rule) => ({ ...rule, filter: null })),
      },
      created_at: '1970-01-01T00:00:00.000Z',
      updated_at: '1970-01-01T00:00:00.000Z',
    };
  }, [meta]);
  const state = useMemo<ViewConfigState>(() => {
    const saved: EffectiveViewConfig = {
      ...meta.view.config,
      filter: null,
      sort: [...initialChoices(meta).sort],
    };
    return {
      config: {
        ...saved,
        filter: choices.filter === null ? null : { ...choices.filter },
        sort: [...choices.sort],
      },
      saved,
      unsaved: [],
      saving: false,
      canSave: false,
      change: (patch) => {
        onChoices({
          ...choices,
          ...(patch.filter === undefined ? {} : { filter: patch.filter }),
          ...(patch.sort === undefined ? {} : { sort: patch.sort }),
        });
      },
      save: () => Promise.resolve(false),
      discard: () => {
        onChoices({ ...initialChoices(meta), search: choices.search });
      },
    };
  }, [meta, choices, onChoices]);

  return (
    <>
      {meta.settings.allow_viewer_filter_sort ? (
        <Controls view={view} fields={fields} orgId="" state={state} queryError={error} />
      ) : null}
      {meta.settings.allow_search ? (
        <div className="ml-auto">
          <Search
            fields={searchFields}
            search={choices.search}
            onSearchChange={(search) => {
              onChoices({ ...choices, search });
            }}
          />
        </div>
      ) : null}
    </>
  );
}
