import { Button, Checkbox, Dialog } from '@cellhive/ui';
import { TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormatters } from '../../../../lib/i18n/format';
import { revealedSecrets } from '../model';

import { CopyField, Note } from './parts';

import type { IncomingWebhookWithSecretsDto } from '@cellhive/contracts';

/** Which call issued the secrets: decides the title and what is listed. */
export type RevealReason = 'created' | 'rotated' | 'bearer';

export interface Reveal {
  readonly reason: RevealReason;
  readonly hook: IncomingWebhookWithSecretsDto;
}

/**
 * The signing secret / Bearer token of a response, shown **once**
 * (CONTRACTS §25.1, BACKLOG T611): a warning, each value with "Copy", and a
 * required "I stored them" check before the dialog closes — Escape and the
 * close button explain instead of closing (`preventDismiss`). The values live
 * only in this component's props: nothing keeps them after it closes.
 */
export function SecretRevealDialog({
  reveal,
  onDone,
}: {
  readonly reveal: Reveal | null;
  readonly onDone: () => void;
}) {
  if (reveal === null) return null;
  return (
    <RevealDialog key={`${reveal.hook.id}:${reveal.reason}`} reveal={reveal} onDone={onDone} />
  );
}

function RevealDialog({
  reveal,
  onDone,
}: {
  readonly reveal: Reveal;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('incomingWebhooks');
  const format = useFormatters();
  const nagId = useId();
  const [saved, setSaved] = useState(false);
  const [nagged, setNagged] = useState(false);
  const checkbox = useRef<HTMLInputElement>(null);
  const items = revealedSecrets(reveal.hook, reveal.reason === 'created');
  const secrets = items.filter((item) => item.kind !== 'url').length;
  const finish = () => {
    if (saved || secrets === 0) {
      onDone();
      return;
    }
    setNagged(true);
    checkbox.current?.focus();
  };
  const hintOf = (kind: (typeof items)[number]['kind']) => {
    if (kind !== 'signing_secret' || reveal.reason !== 'rotated') return t(`reveal.hint.${kind}`);
    const until = reveal.hook.signing_secret_rotating_until;
    return until === null
      ? t('reveal.hint.signing_secret')
      : t('reveal.hint.rotated', { date: format.dateTime(until) });
  };
  return (
    <Dialog
      open
      layout="sheet"
      className="max-w-xl"
      preventDismiss
      onDismissBlocked={finish}
      onOpenChange={(open) => {
        // Only reached when the browser forces a close (Escape pressed repeatedly).
        if (!open) onDone();
      }}
      title={t(`reveal.title.${reveal.reason}`)}
      description={t(`reveal.description.${reveal.reason}`, { name: reveal.hook.name })}
      closeLabel={t('reveal.close')}
    >
      <form
        className="flex flex-col gap-4"
        data-testid="secret-reveal"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        {secrets === 0 ? null : (
          <Note
            tone="warning"
            icon={<TriangleAlert />}
            title={t('reveal.warningTitle')}
            data-testid="secret-reveal-warning"
          >
            {t('reveal.warning', { count: secrets })}
          </Note>
        )}
        {items.map((item) => (
          <CopyField
            key={item.kind}
            label={t(`reveal.label.${item.kind}`)}
            value={item.value}
            hint={hintOf(item.kind)}
            data-testid={`reveal-${item.kind}`}
          />
        ))}
        {secrets === 0 ? null : (
          <div className="flex flex-col gap-1">
            <Checkbox
              ref={checkbox}
              label={t('reveal.confirm', { count: secrets })}
              checked={saved}
              aria-invalid={nagged && !saved}
              aria-describedby={nagged && !saved ? nagId : undefined}
              data-testid="secret-reveal-confirm"
              onChange={(event) => {
                setSaved(event.target.checked);
              }}
            />
            {nagged && !saved ? (
              <p id={nagId} role="alert" className="text-label font-normal text-danger">
                {t('reveal.nag', { count: secrets })}
              </p>
            ) : null}
          </div>
        )}
        <div className="flex justify-end">
          <Button type="submit" data-testid="secret-reveal-done">
            {t('reveal.done')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
