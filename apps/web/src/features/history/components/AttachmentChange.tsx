import { Minus, Paperclip, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cellFilesOf, type CellFile } from '../../../lib/attachments/value';

/** Files added and removed between two values of an attachment cell (by id, in order). */
export function attachmentDiff(
  from: unknown,
  to: unknown,
): { added: CellFile[]; removed: CellFile[]; reordered: boolean } {
  const before = cellFilesOf(from);
  const after = cellFilesOf(to);
  const beforeIds = new Set(before.map((file) => file.id));
  const afterIds = new Set(after.map((file) => file.id));
  const added = after.filter((file) => !beforeIds.has(file.id));
  const removed = before.filter((file) => !afterIds.has(file.id));
  const kept = (files: CellFile[], other: Set<string>) =>
    files.filter((file) => other.has(file.id)).map((file) => file.id);
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    kept(before, afterIds).join(',') !== kept(after, beforeIds).join(',');
  return { added, removed, reordered };
}

/**
 * An attachment change in the history (T418, CONTRACTS §20: values hold
 * `{ id, name, size, mime }`): the files added, the files removed (struck
 * through, "removed" for screen readers), or that they were reordered.
 */
export function AttachmentChange({ from, to }: { from: unknown; to: unknown }) {
  const { t } = useTranslation('history');
  const { added, removed, reordered } = attachmentDiff(from, to);
  if (reordered) {
    return <span className="text-fg-muted">{t('files.reordered')}</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" data-testid="history-attachments">
      {added.map((file) => (
        <span
          key={`+${file.id}`}
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm bg-surface-sunken px-1.5 text-label leading-5 font-normal"
        >
          <Plus aria-hidden="true" className="size-3 shrink-0 text-success" />
          <span className="sr-only">{t('files.added')}</span>
          <Paperclip aria-hidden="true" className="size-3 shrink-0 text-fg-muted" />
          <span className="truncate">{file.name}</span>
        </span>
      ))}
      {removed.map((file) => (
        <span
          key={`-${file.id}`}
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm px-1.5 text-label leading-5 font-normal text-fg-muted"
        >
          <Minus aria-hidden="true" className="size-3 shrink-0 text-danger" />
          <span className="sr-only">{t('files.removed')}</span>
          <s className="truncate">{file.name}</s>
        </span>
      ))}
    </span>
  );
}
