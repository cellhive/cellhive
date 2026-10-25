import {
  EMAIL_FOOTER_POLICIES,
  type AutomationEmailSettingsDto,
  type EmailFooterPolicy,
} from '@cellhive/contracts';
import { cn } from '@cellhive/ui';
import { Info, Lock } from 'lucide-react';
import { useId } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { NoteBox, SettingsSection } from './SettingsSection';

const CODE = <code className="font-mono text-mono" />;

/**
 * Footer policy of automation emails (CONTRACTS §23.4): `required` |
 * `author_choice`. Disabled with the reason while the instance env
 * `EMAIL_AUTOMATION_FOOTER=required` (the stored value has no effect then).
 */
export function FooterPolicySection({
  automation,
  value,
  orgName,
  onChange,
}: {
  readonly automation: AutomationEmailSettingsDto;
  readonly value: EmailFooterPolicy;
  readonly orgName: string;
  readonly onChange: (policy: EmailFooterPolicy) => void;
}) {
  const { t } = useTranslation('emailSettings');
  const name = useId();
  const locked = automation.instance_footer_policy === 'required';
  const noteId = `${name}-note`;
  return (
    <SettingsSection
      data-testid="footer-policy"
      title={t('footer.title')}
      description={t('footer.description')}
    >
      <fieldset
        className="flex flex-col gap-3"
        disabled={locked}
        aria-describedby={locked ? noteId : undefined}
      >
        <legend className="sr-only">{t('footer.legend')}</legend>
        {EMAIL_FOOTER_POLICIES.map((policy) => {
          const hintId = `${name}-${policy}`;
          return (
            <label
              key={policy}
              className={cn(
                'flex min-h-control items-start gap-2.5 lg:min-h-0',
                locked ? 'cursor-not-allowed text-fg-muted' : 'cursor-pointer',
              )}
            >
              <input
                type="radio"
                name={name}
                value={policy}
                data-testid={`footer-${policy}`}
                checked={value === policy}
                aria-describedby={hintId}
                className="mt-0.5 size-4 shrink-0 accent-accent"
                onChange={() => {
                  onChange(policy);
                }}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-body font-medium">{t(`footer.${policy}`)}</span>
                <span id={hintId} className="text-label font-normal text-fg-muted">
                  {t(`footer.${policy}Hint`)}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div id={noteId}>
        {locked ? (
          <NoteBox
            tone="neutral"
            icon={<Lock />}
            title={t('footer.locked.title')}
            data-testid="footer-locked"
          >
            <Trans t={t} i18nKey="footer.locked.body" components={{ code: CODE }} />
          </NoteBox>
        ) : (
          <p
            className="flex items-start gap-2 text-label font-normal text-fg-muted"
            data-testid="footer-org"
          >
            <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>
              <Trans t={t} i18nKey="footer.org" components={{ code: CODE }} />
            </span>
          </p>
        )}
      </div>
      <p className="text-label font-normal text-fg-muted">
        <Trans
          t={t}
          i18nKey="footer.minimal"
          values={{ org: orgName }}
          components={{ q: <q className="text-fg" /> }}
        />
      </p>
    </SettingsSection>
  );
}
