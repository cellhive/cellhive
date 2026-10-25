import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { SignatureEditor } from '../../email-identities/components/SignatureEditor';

import { SettingsSection } from './SettingsSection';

/**
 * The organization's default signature (CONTRACTS §23.4), used by emails of
 * the system sender: the same editor as the signature of a sender identity
 * (T533) — narrow Markdown with a toolbar, at most 2,000 characters, no
 * placeholders, up to two images uploaded to the organization (T534).
 * `serverError` is a `422` detail on `default_signature_md`.
 */
export function SignatureSection({
  orgId,
  value,
  onChange,
  serverError,
}: {
  readonly orgId: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly serverError: string | undefined;
}) {
  const { t } = useTranslation('emailSettings');
  const imageTarget = useMemo(() => ({ kind: 'org' as const, orgId }), [orgId]);
  return (
    <SettingsSection
      data-testid="signature"
      title={t('signature.title')}
      description={t('signature.description')}
    >
      <SignatureEditor
        value={value}
        onChange={onChange}
        serverError={serverError}
        imageTarget={imageTarget}
      />
    </SettingsSection>
  );
}
