import { Button, Spinner } from '@cellhive/ui';
import { LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { showErrorToast } from '../../../lib/toast/toast';
import { useCreateView } from '../mutations';

/**
 * A table the user reads without any view they may see (`visible_views`
 * hides every shared view, no personal view yet). Anyone who reads a table
 * may create a personal view (BACKLOG S3 decision 4).
 */
export function NoViews({ baseId, tableId }: { baseId: string; tableId: string }) {
  const { t } = useTranslation('view');
  const navigate = useNavigate();
  const create = useCreateView(tableId);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-canvas p-8 text-center">
      <LayoutGrid aria-hidden="true" className="size-8 text-fg-muted" />
      <h2 className="text-heading">{t('none.title')}</h2>
      <p className="max-w-md text-fg-muted">{t('none.description')}</p>
      <Button
        disabled={create.isPending}
        onClick={() => {
          create.mutate(
            { name: t('defaultName.grid'), type: 'grid', is_personal: true },
            {
              onSuccess: (view) => {
                void navigate(
                  `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}/v/${encodeURIComponent(view.id)}`,
                );
              },
              onError: (error) => showErrorToast(error),
            },
          );
        }}
      >
        {create.isPending ? <Spinner /> : null}
        {t('none.create')}
      </Button>
    </div>
  );
}
