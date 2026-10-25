import { Skeleton } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Lock } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import { ancestorsQuery } from '../tree';

export interface ParentPathProps {
  readonly tableId: string;
  readonly recordId: string;
  /** The record's parent (`null`: a root, nothing to show). */
  readonly parentId: string;
  readonly version: number | undefined;
  readonly onNavigate: (recordId: string) => void;
  readonly className?: string;
}

/**
 * Parent path of a sub-record under the panel's meta line (design board
 * S4RecordMobile, T417): the ancestors, root first, as links that open them
 * in the panel; an ancestor the user cannot read is a lock placeholder.
 */
export function ParentPath({
  tableId,
  recordId,
  parentId,
  version,
  onNavigate,
  className,
}: ParentPathProps) {
  const { t } = useTranslation('record');
  const ancestors = useQuery(ancestorsQuery(tableId, recordId, parentId, version));
  const items = ancestors.data?.items;
  if (items === undefined) {
    return ancestors.isPending ? (
      <div className={className} aria-hidden="true">
        <Skeleton className="my-1 h-4 w-48" />
      </div>
    ) : null;
  }
  if (items.length === 0) return null;
  return (
    <nav aria-label={t('tree.parentPath')} className={className}>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-label font-normal text-fg-muted">
        {items.map((ancestor, index) => (
          <Fragment key={ancestor.id ?? `locked-${String(index)}`}>
            {index === 0 ? null : (
              <li aria-hidden="true" className="flex">
                <ChevronRight className="size-3" />
              </li>
            )}
            <li className="flex min-h-6 min-w-0 items-center">
              {ancestor.locked || ancestor.id === null ? (
                <span className="inline-flex items-center gap-1">
                  <Lock aria-hidden="true" className="size-3" />
                  <span className="sr-only">{t('tree.lockedAncestor')}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="inline-flex min-h-6 max-w-full items-center truncate rounded-sm text-accent underline underline-offset-2 hover:no-underline"
                  onClick={() => {
                    if (ancestor.id !== null) onNavigate(ancestor.id);
                  }}
                >
                  <span className="truncate">{ancestor.title ?? t('untitled')}</span>
                </button>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
