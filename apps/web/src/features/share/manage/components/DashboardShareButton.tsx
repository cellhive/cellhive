import { Button } from '@cellhive/ui';
import { Share2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { canCreateShareLink } from '../../../../lib/permissions/access';

import type { DashboardShareActionProps } from '../../../../lib/share/dashboard-share';

/** The dialog and its data layer load on first use (FRONTEND §11.1). */
const ShareDialog = lazy(() => import('./ShareDialog'));

/**
 * (T814) "Share" in the heading of a dashboard (given to the dashboard page
 * by the route, FRONTEND §1.2): opens the share dialog of the dashboard —
 * audience, password, expiry, its options and the "Embed" tab. Shown with
 * the right to share (base admin/owner or `base_rule.share_link`, CONTRACTS
 * §16); reading the dashboard is given (the page is open). UX only: the
 * server decides.
 */
export function DashboardShareButton({ dashboard, base }: DashboardShareActionProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  if (!canCreateShareLink(base.access)) return null;
  return (
    <>
      <Button
        variant="secondary"
        aria-label={t('share.dashboardLabel', { name: dashboard.name })}
        aria-haspopup="dialog"
        data-testid="dashboard-share"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Share2 aria-hidden="true" />
        {t('share.button')}
      </Button>
      {open
        ? createPortal(
            <Suspense fallback={null}>
              <ShareDialog
                target={{ kind: 'dashboard', dashboard }}
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

export default DashboardShareButton;
