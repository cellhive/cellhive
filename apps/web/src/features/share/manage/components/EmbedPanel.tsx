import { MAX_EMBED_ORIGINS, type ShareLinkDto } from '@cellhive/contracts';
import { Alert, Button, FormField, Input } from '@cellhive/ui';
import { Copy, Plus, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { showToast } from '../../../../lib/toast/toast';
import { useUpdateShareLink, type ShareContext } from '../api';
import { embedBlockedBy } from '../draft';
import { addOrigin, embedCode, pastedLinkUrl, type OriginProblem } from '../embed';

import { ShareOption } from './ShareOption';

export interface EmbedPanelProps {
  readonly link: ShareLinkDto;
  readonly context: ShareContext;
  /** Name of what is shared: the frame's `title`. */
  readonly name: string;
  /** Full address of the link while it is known (right after create/regenerate). */
  readonly revealed: string | null;
}

/**
 * (T814) The "Embed" tab of the share dialog, for views, forms and
 * dashboards (BACKLOG S7 decisions #14–#16, CONTRACTS §16): embedding is
 * possible only for a `public` link without password (else the switch is
 * disabled with the reason — the API answers `422 EMBED_NOT_SUPPORTED`),
 * only from the sites listed (`frame-ancestors`, 1–20 origins), and the
 * `<iframe>` code to paste there. Changes apply at once, like the other
 * switches of an existing link. The code needs the full address, shown
 * only once: it is built from the address just created, or from the
 * address the owner pastes back.
 */
export function EmbedPanel({ link, context, name, revealed }: EmbedPanelProps) {
  const { t } = useTranslation('share');
  const update = useUpdateShareLink(context);
  const { enabled, allowed_origins: origins } = link.settings.embed;
  const blocked = embedBlockedBy(link);
  const save = (embed: { enabled?: boolean; allowed_origins?: string[] }, message: string) => {
    update.mutate(
      { linkId: link.id, body: { settings: { embed } } },
      {
        onSuccess: () => {
          showToast({ variant: 'success', message });
        },
      },
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="share-embed">
      <p className="text-body text-fg-muted">{t('embed.description')}</p>
      {blocked === null ? null : (
        <Alert variant="info" data-testid="share-embed-blocked">
          {t(blocked === 'audience' ? 'embed.blockedAudience' : 'embed.blockedPassword')}
        </Alert>
      )}
      <ShareOption
        control="switch"
        label={t('embed.enable')}
        hint={
          blocked === null && origins.length === 0 && !enabled
            ? t('embed.enableNeedsOrigin')
            : t('embed.enableHint')
        }
        checked={enabled}
        disabled={update.isPending || (!enabled && (blocked !== null || origins.length === 0))}
        onChange={(event) => {
          const on = event.target.checked;
          save({ enabled: on }, on ? t('embed.enabled') : t('embed.disabled'));
        }}
      />
      <OriginList
        origins={origins}
        pending={update.isPending}
        onAdd={(origin) => {
          save({ allowed_origins: [...origins, origin] }, t('embed.originAdded'));
        }}
        onRemove={(origin) => {
          const rest = origins.filter((item) => item !== origin);
          // The API refuses embedding without any site: the last one turns it off too.
          save(
            rest.length === 0 && enabled
              ? { enabled: false, allowed_origins: rest }
              : { allowed_origins: rest },
            t('embed.originRemoved'),
          );
        }}
      />
      {update.isError ? <ErrorAlert error={update.error} /> : null}
      <EmbedCode link={link} name={name} revealed={revealed} />
    </div>
  );
}

const PROBLEM_TEXT: Record<OriginProblem, string> = {
  invalid: 'embed.originInvalid',
  duplicate: 'embed.originDuplicate',
  tooMany: 'embed.originTooMany',
};

/** The sites allowed to frame the link: a list with "Remove", and a field to add one. */
function OriginList({
  origins,
  pending,
  onAdd,
  onRemove,
}: {
  origins: readonly string[];
  pending: boolean;
  onAdd: (origin: string) => void;
  onRemove: (origin: string) => void;
}) {
  const { t } = useTranslation('share');
  const headingId = useId();
  const hintId = useId();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<OriginProblem | null>(null);
  const add = () => {
    if (pending || value.trim() === '') return;
    const result = addOrigin(value, origins);
    if ('problem' in result) {
      setProblem(result.problem);
      return;
    }
    onAdd(result.origin);
    setValue('');
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-body font-semibold">
        {t('embed.origins')}
      </h3>
      {origins.length === 0 ? (
        <p className="text-label font-normal text-fg-muted">{t('embed.noOrigins')}</p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col gap-1" data-testid="embed-origins">
          {origins.map((origin) => (
            <li
              key={origin}
              className="flex min-h-control items-center justify-between gap-2 rounded-md border border-line px-3"
            >
              <span className="min-w-0 truncate font-mono text-mono">{origin}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-control shrink-0"
                aria-label={t('embed.removeOrigin', { origin })}
                disabled={pending}
                onClick={() => {
                  onRemove(origin);
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <FormField label={t('embed.addLabel')} className="min-w-0 flex-1">
          {(control) => (
            <Input
              {...control}
              type="url"
              inputMode="url"
              placeholder={t('embed.addPlaceholder')}
              aria-describedby={hintId}
              aria-invalid={problem === null ? undefined : true}
              value={value}
              data-testid="embed-origin-input"
              onChange={(event) => {
                setValue(event.target.value);
                setProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                add();
              }}
            />
          )}
        </FormField>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || value.trim() === ''}
          onClick={add}
        >
          <Plus aria-hidden="true" />
          {t('embed.add')}
        </Button>
      </div>
      {problem === null ? (
        <p id={hintId} className="text-label font-normal text-fg-muted">
          {t('embed.addHint', { max: MAX_EMBED_ORIGINS })}
        </p>
      ) : (
        <p
          id={hintId}
          role="alert"
          className="text-label font-normal text-danger"
          data-testid="embed-origin-error"
        >
          {t(PROBLEM_TEXT[problem])}
        </p>
      )}
    </section>
  );
}

/**
 * The `<iframe>` code, read-only with "Copy code", once the full address is
 * known: just created, or pasted back (the token is shown only once —
 * CONTRACTS §16).
 */
function EmbedCode({
  link,
  name,
  revealed,
}: {
  link: ShareLinkDto;
  name: string;
  revealed: string | null;
}) {
  const { t } = useTranslation('share');
  const headingId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [pasted, setPasted] = useState('');
  const pastedUrl = pasted.trim() === '' ? null : pastedLinkUrl(pasted, link.token_prefix);
  const url = revealed ?? pastedUrl;
  const code = url === null ? null : embedCode(url, name, link.target_type);
  const copy = async () => {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast({ variant: 'success', message: t('embed.codeCopied') });
    } catch {
      area.current?.select();
      showToast({ variant: 'error', message: t('link.copyFailed') });
    }
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-body font-semibold">
        {t('embed.code')}
      </h3>
      {revealed === null ? (
        <FormField
          label={t('embed.pasteLabel')}
          hint={t('embed.pasteHint')}
          error={pasted.trim() !== '' && pastedUrl === null ? t('embed.pasteInvalid') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              type="url"
              inputMode="url"
              autoComplete="off"
              value={pasted}
              data-testid="embed-paste-link"
              onChange={(event) => {
                setPasted(event.target.value);
              }}
            />
          )}
        </FormField>
      ) : null}
      {code === null ? null : (
        <>
          <textarea
            ref={area}
            readOnly
            aria-labelledby={headingId}
            value={code}
            rows={6}
            spellCheck={false}
            data-testid="embed-code"
            className="w-full resize-none rounded-md border border-line-control bg-surface-sunken p-3 font-mono text-mono text-fg"
            onFocus={(event) => {
              event.target.select();
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-label font-normal text-fg-muted">{t('embed.codeHint')}</p>
            <Button
              type="button"
              onClick={() => {
                void copy();
              }}
            >
              <Copy aria-hidden="true" />
              {t('embed.copyCode')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
