import { Button, Dialog } from '@cellhive/ui';
import { useTranslation } from 'react-i18next';

import { showToast } from '../../../../lib/toast/toast';

import { IdentityForm } from './IdentityForm';
import { VerifyPanel } from './VerifyPanel';

import type {
  EmailIdentityDto,
  EmailSettingsDto,
  EmailVerificationOutcome,
} from '@cellhive/contracts';
import type { ReactNode } from 'react';

/** What the drawer shows: the form (new or existing identity) or the verification of one. */
export type DrawerState =
  | {
      readonly view: 'form';
      readonly identityId: string | null;
      /** (T556) "Fix display name": the display name field gets the focus. */
      readonly focus?: 'displayName';
    }
  | {
      readonly view: 'verify';
      readonly identityId: string;
      readonly outcome: EmailVerificationOutcome | null;
    }
  | null;

export interface IdentityDrawerProps {
  readonly orgId: string;
  readonly state: DrawerState;
  readonly identities: readonly EmailIdentityDto[];
  readonly settings: EmailSettingsDto | undefined;
  readonly orgLocale: string | null;
  readonly bases: readonly { id: string; name: string }[] | undefined;
  readonly onState: (state: DrawerState) => void;
}

function Footer({ children }: { readonly children: ReactNode }) {
  return (
    <div className="sticky bottom-0 -mx-6 -mb-6 border-t border-line bg-surface px-6 py-4">
      {children}
    </div>
  );
}

/**
 * The right-hand drawer of the identity page (board "S5 · Email identities
 * - thêm danh tính"; a bottom sheet on phones): add or edit, then — when the
 * save sent a verification email — the verification of the same identity.
 */
export function IdentityDrawer({
  orgId,
  state,
  identities,
  settings,
  orgLocale,
  bases,
  onState,
}: IdentityDrawerProps) {
  const { t } = useTranslation('emailIdentities');
  const identity =
    state === null || state.identityId === null
      ? null
      : (identities.find((item) => item.id === state.identityId) ?? null);
  const close = () => {
    onState(null);
  };
  let title: string;
  let body: ReactNode = null;
  if (state?.view === 'verify' && identity !== null) {
    title = t('verify.title', { email: identity.email });
    body = (
      <>
        <VerifyPanel
          identity={identity}
          outcome={state.outcome}
          onOutcome={(outcome) => {
            onState({ view: 'verify', identityId: identity.id, outcome });
          }}
          onVerified={(verified) => {
            showToast({
              variant: 'success',
              message: t('verify.toast', { email: verified.email }),
            });
          }}
        />
        <Footer>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={close}>
              {t('verify.close')}
            </Button>
          </div>
        </Footer>
      </>
    );
  } else if (state?.view === 'form' && (state.identityId === null || identity !== null)) {
    title =
      identity === null ? t('form.addTitle') : t('form.editTitle', { name: identity.display_name });
    body = (
      <IdentityForm
        key={state.identityId ?? 'new'}
        orgId={orgId}
        identity={identity}
        settings={settings}
        orgLocale={orgLocale}
        bases={bases}
        onCancel={close}
        footer={(actions) => <Footer>{actions}</Footer>}
        focusDisplayName={state.focus === 'displayName'}
        onSaved={(result) => {
          if (result.verification !== null) {
            onState({
              view: 'verify',
              identityId: result.identity.id,
              outcome: result.verification,
            });
            return;
          }
          showToast({
            variant: 'success',
            message: t('form.saved', { name: result.identity.display_name }),
          });
          close();
        }}
      />
    );
  } else {
    title = t('form.addTitle');
  }
  return (
    <Dialog
      open={body !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={title}
      closeLabel={t('form.close')}
      layout="drawer"
      className="overflow-y-auto"
    >
      {body}
    </Dialog>
  );
}
