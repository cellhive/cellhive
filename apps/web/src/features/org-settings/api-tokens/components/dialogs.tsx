import { Button, Checkbox, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { showToast } from '../../../../lib/toast/toast';
import { apiTokenKeys, apiTokensApi, useRevokeToken } from '../api';
import { curlExample } from '../model';

import { McpConnect } from './mcp';
import { CopyField, Note } from './parts';

import type { ApiTokenDto, OrgApiTokenDto } from '@cellhive/contracts';

const NAME_PATH = ['name'];

/** A created token as the "shown once" dialog takes it: name and value only. */
export interface RevealedToken {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  /** Created from an MCP preset: the dialog shows how to connect a client (T924). */
  readonly mcp: boolean;
}

/**
 * The new token, shown **once** (CONTRACTS §26.1): a warning, the value and a
 * curl example — or, for an MCP preset, the "Connect via MCP" box — with "Copy", and a required "I've saved it" check before the
 * dialog closes. The value lives only in the caller's component state (never
 * in storage, the URL or the query cache — FRONTEND §12) and is dropped when
 * the dialog closes.
 */
export function TokenRevealDialog({
  reveal,
  onDone,
}: {
  readonly reveal: RevealedToken | null;
  readonly onDone: () => void;
}) {
  if (reveal === null) return null;
  return <RevealDialog key={reveal.id} reveal={reveal} onDone={onDone} />;
}

function RevealDialog({
  reveal,
  onDone,
}: {
  readonly reveal: RevealedToken;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation('apiTokens');
  const nagId = useId();
  const [saved, setSaved] = useState(false);
  const [nagged, setNagged] = useState(false);
  const checkbox = useRef<HTMLInputElement>(null);
  const finish = () => {
    if (saved) {
      onDone();
      return;
    }
    setNagged(true);
    checkbox.current?.focus();
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
      title={t('reveal.title')}
      description={t('reveal.description', { name: reveal.name })}
      closeLabel={t('page.close')}
    >
      <form
        className="flex flex-col gap-4"
        data-testid="token-reveal"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <Note tone="warning" icon={<TriangleAlert />} title={t('reveal.warningTitle')}>
          {t('reveal.warning')}
        </Note>
        <CopyField label={t('reveal.label')} value={reveal.token} data-testid="token-value" />
        {reveal.mcp ? (
          <McpConnect token={reveal.token} masked={false} />
        ) : (
          <CopyField
            label={t('reveal.example')}
            value={curlExample(window.location.origin, reveal.token)}
            hint={t('reveal.exampleHint')}
            multiline
            data-testid="token-curl"
          />
        )}
        <div className="flex flex-col gap-1">
          <Checkbox
            ref={checkbox}
            label={t('reveal.confirm')}
            checked={saved}
            aria-invalid={nagged && !saved}
            aria-describedby={nagged && !saved ? nagId : undefined}
            data-testid="token-reveal-confirm"
            onChange={(event) => {
              setSaved(event.target.checked);
            }}
          />
          {nagged && !saved ? (
            <p id={nagId} role="alert" className="text-label font-normal text-danger">
              {t('reveal.nag')}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button type="submit" data-testid="token-reveal-done">
            {t('reveal.done')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Rename one of the caller's tokens (`PATCH /api-tokens/:id { name }`, owner only). */
export function RenameTokenDialog({
  orgId,
  token,
  onClose,
}: {
  readonly orgId: string;
  readonly token: ApiTokenDto | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('apiTokens');
  return (
    <Dialog
      open={token !== null}
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('rename.title')}
      closeLabel={t('page.close')}
    >
      {token === null ? null : (
        <RenameForm key={token.id} orgId={orgId} token={token} onClose={onClose} />
      )}
    </Dialog>
  );
}

function RenameForm({
  orgId,
  token,
  onClose,
}: {
  readonly orgId: string;
  readonly token: ApiTokenDto;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('apiTokens');
  const queryClient = useQueryClient();
  const [name, setName] = useState(token.name);
  const [error, setError] = useState<string | undefined>(undefined);
  const rename = useMutation({
    mutationFn: (value: string) => apiTokensApi.rename(token.id, value),
    onSuccess: () => {
      showToast({ variant: 'success', message: t('toast.renamed') });
      onClose();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: apiTokenKeys.all(orgId) }),
  });
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      data-testid="token-rename-form"
      onSubmit={(event) => {
        event.preventDefault();
        const value = name.trim();
        if (value === '') {
          setError(t('create.errors.nameRequired'));
          return;
        }
        if (value.length > 100) {
          setError(t('create.errors.nameInvalid'));
          return;
        }
        rename.mutate(value);
      }}
    >
      <FormField label={t('create.name')} error={error}>
        {(control) => (
          <Input
            {...control}
            value={name}
            maxLength={100}
            autoComplete="off"
            data-testid="token-rename-name"
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
          />
        )}
      </FormField>
      {rename.isError ? <ErrorAlert error={rename.error} hidePaths={NAME_PATH} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('page.cancel')}
        </Button>
        <Button type="submit" disabled={rename.isPending} data-testid="token-rename-save">
          {rename.isPending ? <Spinner /> : null}
          {t('rename.save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * Revoke a token (`alertdialog`): integrations using it stop immediately
 * (CONTRACTS §26.4; T706 closes its WebSocket connections).
 */
export function RevokeTokenDialog({
  orgId,
  token,
  onClose,
}: {
  readonly orgId: string;
  readonly token: ApiTokenDto | OrgApiTokenDto | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('apiTokens');
  const revoke = useRevokeToken(orgId);
  const close = () => {
    revoke.reset();
    onClose();
  };
  return (
    <Dialog
      open={token !== null}
      role="alertdialog"
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={token === null ? '' : t('revoke.title', { name: token.name })}
      description={
        token !== null && 'user' in token
          ? t('revoke.descriptionOther', { owner: token.user.display_name })
          : t('revoke.description')
      }
      closeLabel={t('page.close')}
    >
      {token === null ? null : (
        <div className="flex flex-col gap-4" data-testid="token-revoke-dialog">
          {revoke.isError ? <ErrorAlert error={revoke.error} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              {t('page.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={revoke.isPending}
              data-testid="token-revoke-confirm"
              onClick={() => {
                revoke.mutate(token.id, {
                  onSuccess: () => {
                    showToast({
                      variant: 'success',
                      message: t('toast.revoked', { name: token.name }),
                    });
                    close();
                  },
                });
              }}
            >
              {revoke.isPending ? <Spinner /> : null}
              {t('revoke.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
