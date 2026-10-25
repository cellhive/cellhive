import { ClipboardList, SquareKanban } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ViewDto } from '@cellhive/contracts';

/** Kanban (T314) and form (T315) views until their screens exist. */
export function ViewPlaceholder({ view }: { view: ViewDto }) {
  const { t } = useTranslation('view');
  const type = view.type === 'form' ? 'form' : 'kanban';
  const Icon = type === 'form' ? ClipboardList : SquareKanban;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-canvas p-8 text-center">
      <Icon aria-hidden="true" className="size-8 text-fg-muted" />
      <h2 className="text-heading">{t(`placeholder.${type}.title`)}</h2>
      <p className="max-w-md text-fg-muted">{t(`placeholder.${type}.description`)}</p>
    </div>
  );
}
