import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2, TableProperties, Upload } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { baseQuery, fieldsQuery } from '../../../lib/query/queries';
import { canAppendTo, canImportNewTable } from '../mapping';

import type { ImportTarget } from './types';

/** The wizard is its own chunk, loaded when a user first opens it (FRONTEND §11.1). */
const ImportWizard = lazy(() => import('./ImportWizard'));

export interface ImportMenuProps {
  readonly baseId: string;
  /** The open table: offers appending to it besides a new table. */
  readonly table?: { readonly id: string; readonly name: string } | undefined;
}

function Reason({ text }: { text: string }) {
  return <span className="block text-label font-normal text-fg-muted">{text}</span>;
}

/**
 * "Import" (T318, CONTRACTS §19): on a table, a menu with "Import into this
 * table" (append: `edit` + `add` and a writable field) and "Import as a new
 * table" (base admins); on a base without a table, a button for the latter.
 * An entry the user may not use is disabled with the reason; the button is
 * hidden when neither is possible (FRONTEND §7). The server checks again.
 */
export function ImportMenu({ baseId, table }: ImportMenuProps) {
  const { t } = useTranslation('import');
  const { data: base } = useQuery(baseQuery(baseId));
  const fields = useQuery({ ...fieldsQuery(table?.id ?? ''), enabled: table !== undefined });
  const [target, setTarget] = useState<ImportTarget | null>(null);

  const access = base?.access;
  const createAllowed = canImportNewTable(access);
  const appendAllowed =
    table !== undefined && canAppendTo(access, table.id, fields.data?.items ?? []);

  const wizard =
    target === null ? null : (
      <Suspense fallback={null}>
        <ImportWizard
          baseId={baseId}
          target={target}
          onClose={() => {
            setTarget(null);
          }}
        />
      </Suspense>
    );

  if (table === undefined) {
    if (!createAllowed) return null;
    return (
      <>
        <Button
          variant="secondary"
          onClick={() => {
            setTarget({ mode: 'create_table' });
          }}
        >
          <Upload aria-hidden="true" />
          {t('menu.createButton')}
        </Button>
        {wizard}
      </>
    );
  }

  if (!createAllowed && !appendAllowed) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="shrink-0">
            <Upload aria-hidden="true" />
            {t('menu.button')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-80">
          <DropdownMenuItem
            disabled={!appendAllowed}
            onSelect={() => {
              setTarget({ mode: 'append', tableId: table.id, tableName: table.name });
            }}
          >
            <TableProperties aria-hidden="true" />
            <span>
              {t('menu.append', { table: table.name })}
              {appendAllowed ? null : <Reason text={t('menu.appendDenied')} />}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!createAllowed}
            onSelect={() => {
              setTarget({ mode: 'create_table' });
            }}
          >
            <FilePlus2 aria-hidden="true" />
            <span>
              {t('menu.create')}
              {createAllowed ? null : <Reason text={t('menu.createDenied')} />}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {wizard}
    </>
  );
}

export default ImportMenu;
