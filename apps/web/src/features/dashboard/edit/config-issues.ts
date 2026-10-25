import {
  MAX_WIDGET_TITLE_LENGTH,
  WIDGET_CONFIG_SCHEMAS,
  type WidgetType,
} from '@cellhive/contracts';

import { isApiError } from '../../../lib/api/client';
import { issueToDetail, type Detail } from '../../../lib/forms/zod-form';

import type { WidgetContent } from './editor-session';

/**
 * Problems of a widget's settings by path (T812): `title`, or a path in the
 * config as the API writes it without the `config.` prefix
 * (`metrics[0].field`, `dimension.date_bucket`). `''` holds what belongs to
 * no field. Details are translated where they are shown (`translateDetail`).
 */
export type ConfigIssues = ReadonlyMap<string, readonly Detail[]>;

export const NO_ISSUES: ConfigIssues = new Map();

function add(map: Map<string, Detail[]>, path: string, detail: Detail): void {
  const list = map.get(path) ?? [];
  list.push(detail);
  map.set(path, list);
}

/** `["metrics", 0, "field"]` → `metrics[0].field`. */
export function joinPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((joined, part) => {
    if (typeof part === 'number') return `${joined}[${String(part)}]`;
    const key = String(part);
    return joined === '' ? key : `${joined}.${key}`;
  }, '');
}

/** The checks the editor makes before saving: the config schema of the type, the title length. */
export function clientIssues(type: WidgetType, content: WidgetContent): ConfigIssues {
  const map = new Map<string, Detail[]>();
  if (content.title.trim().length > MAX_WIDGET_TITLE_LENGTH) {
    add(map, 'title', {
      code: 'TOO_BIG',
      params: { maximum: MAX_WIDGET_TITLE_LENGTH, origin: 'string' },
    });
  }
  const parsed = WIDGET_CONFIG_SCHEMAS[type].safeParse(content.config);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(map, joinPath(issue.path), issueToDetail(issue));
  }
  return map;
}

/** The field errors of a refused save (`422`, CONTRACTS §6), by path. */
export function serverIssues(error: unknown): ConfigIssues {
  const map = new Map<string, Detail[]>();
  if (!isApiError(error)) return map;
  if (error.errors.length === 0) {
    add(map, '', { code: error.code });
    return map;
  }
  for (const item of error.errors) {
    const path = item.path.startsWith('config.')
      ? item.path.slice('config.'.length)
      : item.path === 'config'
        ? ''
        : item.path;
    add(map, path, {
      code: item.code,
      ...(item.params === undefined ? {} : { params: item.params }),
    });
  }
  return map;
}

/** Issues at `path` or below it (`metrics[0]` holds `metrics[0].field`). */
export function issuesUnder(issues: ConfigIssues, path: string): Detail[] {
  const found: Detail[] = [];
  for (const [key, details] of issues) {
    if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) {
      found.push(...details);
    }
  }
  return found;
}
