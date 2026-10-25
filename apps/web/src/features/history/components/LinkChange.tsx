import { Lock, Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * A linked record in a history value (CONTRACTS §11.1, T465): the title is
 * the one the viewer may read **now** (`null`: no access, P20), and
 * `deleted` marks a record deleted since.
 */
export interface HistoryLinkRef {
  readonly id: string;
  readonly title: string | null;
  readonly deleted: boolean;
}

function refsOf(value: unknown): HistoryLinkRef[] {
  const items = Array.isArray(value) ? (value as unknown[]) : value === null ? [] : [value];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const ref = item as { id?: unknown; title?: unknown; deleted?: unknown };
    if (typeof ref.id !== 'string') return [];
    return [
      {
        id: ref.id,
        title: typeof ref.title === 'string' ? ref.title : null,
        deleted: ref.deleted === true,
      },
    ];
  });
}

/** Records linked and unlinked between two values of a link cell (by id, in order). */
export function linkDiff(
  from: unknown,
  to: unknown,
): { added: HistoryLinkRef[]; removed: HistoryLinkRef[]; reordered: boolean } {
  const before = refsOf(from);
  const after = refsOf(to);
  const beforeIds = new Set(before.map((ref) => ref.id));
  const afterIds = new Set(after.map((ref) => ref.id));
  const added = after.filter((ref) => !beforeIds.has(ref.id));
  const removed = before.filter((ref) => !afterIds.has(ref.id));
  const kept = (refs: HistoryLinkRef[], other: Set<string>) =>
    refs.filter((ref) => other.has(ref.id)).map((ref) => ref.id);
  const reordered =
    added.length === 0 &&
    removed.length === 0 &&
    kept(before, afterIds).join(',') !== kept(after, beforeIds).join(',');
  return { added, removed, reordered };
}

/** The label of a linked record: its title, "Deleted record" or a lock ("No access"). */
function RefLabel({ refItem }: { refItem: HistoryLinkRef }) {
  const { t } = useTranslation('grid');
  if (refItem.deleted) {
    return <span className="truncate text-fg-muted">{t('value.deletedRecord')}</span>;
  }
  if (refItem.title === null) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-fg-muted">
        <Lock aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{t('value.noAccess')}</span>
      </span>
    );
  }
  return <span className="truncate">{refItem.title === '' ? '—' : refItem.title}</span>;
}

/**
 * A link cell change in the history (T465; built from the attachment
 * change of T418 and the link chips of T413 — the board "S4b · Record
 * history (links)" did not exist yet): the records linked (+) and unlinked
 * (−, struck through), each as a chip with the title the viewer reads now,
 * a lock chip for records they cannot read (P20) and "Deleted record" for
 * records deleted since; or that the links were reordered.
 */
export function LinkChange({ from, to }: { from: unknown; to: unknown }) {
  const { t } = useTranslation('history');
  const { added, removed, reordered } = linkDiff(from, to);
  if (reordered) {
    return <span className="text-fg-muted">{t('links.reordered')}</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" data-testid="history-links">
      {added.map((ref) => (
        <span
          key={`+${ref.id}`}
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm bg-surface-sunken px-1.5 text-label leading-5 font-normal"
        >
          <Plus aria-hidden="true" className="size-3 shrink-0 text-success" />
          <span className="sr-only">{t('links.added')}</span>
          <RefLabel refItem={ref} />
        </span>
      ))}
      {removed.map((ref) => (
        <span
          key={`-${ref.id}`}
          className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm px-1.5 text-label leading-5 font-normal text-fg-muted"
        >
          <Minus aria-hidden="true" className="size-3 shrink-0 text-danger" />
          <span className="sr-only">{t('links.removed')}</span>
          <s className="inline-flex min-w-0 items-center">
            <RefLabel refItem={ref} />
          </s>
        </span>
      ))}
    </span>
  );
}
