import { Button } from '@cellhive/ui';
import { Share2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { canAddRecord, canCreateShareLink } from '../../../../lib/permissions/access';

import type { BaseDetail, ViewDto } from '@cellhive/contracts';

/** The dialog and its data layer load on first use (FRONTEND §11.1). */
const ShareDialog = lazy(() => import('./ShareDialog'));

export interface ShareButtonProps {
  readonly view: ViewDto;
  readonly base: BaseDetail;
}

/**
 * Whether the caller may share `view` (FRONTEND §7, CONTRACTS §16): base
 * admin/owner or `base_rule.share_link`; personal views cannot be shared,
 * forms also need `add` on the table. UX only: the server decides.
 */
export function canShareView(base: BaseDetail, view: ViewDto): boolean {
  if (view.is_personal || !canCreateShareLink(base.access)) return false;
  if (view.type === 'form') {
    return base.access.is_admin || canAddRecord(base.access, view.table_id);
  }
  return true;
}

/** "Share" in the view bar: opens the share dialog of the open view (T316). */
export function ShareButton({ view, base }: ShareButtonProps) {
  // Its strings live in `common` (always loaded): the button is there from
  // the first paint, never popping into the view bar while the grid is in use.
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  if (!canShareView(base, view)) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        aria-label={t('share.buttonLabel', { name: view.name })}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Share2 aria-hidden="true" />
        {t('share.button')}
      </Button>
      {open
        ? // Out of the view bar's DOM (T322b): its phone rules (icon-only buttons) must
          // not reach the dialog's buttons.
          createPortal(
            <Suspense fallback={null}>
              <ShareDialog
                target={{ kind: 'view', view }}
                base={base}
                onClose={() => {
                  setOpen(false);
                }}
              />
            </Suspense>,
            document.body,
          )
        : null}
    </>
  );
}

export default ShareButton;
