import { Button, cn, Dialog, Spinner, Switch } from '@cellhive/ui';
import { Info } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { showToast } from '../../../../lib/toast/toast';
import { useSetTokenPolicy } from '../api';
import { MCP_CLIENTS, maskedToken, mcpSnippet, mcpUrl, type McpClient } from '../model';

import { CopyField, Note, Section } from './parts';

import type { ApiTokenDto, McpPolicy } from '@cellhive/contracts';

type McpKey = keyof McpPolicy;

/**
 * "MCP clients" of the policy tab (BACKLOG T924, CONTRACTS §30.1): two
 * switches that apply at once, like the record-data switch of the AI page
 * (F§15.8). Turning either on asks first: MCP sends what members can read to
 * the model of their own client (whatever `allow_record_data` of the AI
 * settings says), and writes open the door to prompt injection and to
 * duplicates on retry. Turning off never asks.
 */
export function McpPolicySection({
  orgId,
  mcp,
}: {
  readonly orgId: string;
  readonly mcp: McpPolicy;
}) {
  const { t } = useTranslation('apiTokens');
  const save = useSetTokenPolicy(orgId);
  const [confirming, setConfirming] = useState<McpKey | null>(null);
  const apply = (key: McpKey, on: boolean) => {
    save.mutate(
      { mcp: { [key]: on } },
      {
        onSuccess: () => {
          setConfirming(null);
          showToast({
            variant: 'success',
            message: t(`mcp.policy.toast.${key}.${on ? 'on' : 'off'}`),
          });
        },
      },
    );
  };
  const close = () => {
    if (save.isPending) return;
    setConfirming(null);
    save.reset();
  };

  return (
    <Section title={t('mcp.policy.title')} intro={t('mcp.policy.intro')} data-testid="mcp-policy">
      <div className="flex flex-col gap-5">
        <SwitchRow
          label={t('mcp.policy.enabled')}
          hint={t(mcp.enabled ? 'mcp.policy.enabledOn' : 'mcp.policy.enabledOff')}
          checked={mcp.enabled}
          disabled={save.isPending}
          pending={
            save.isPending && confirming === null && save.variables.mcp?.enabled !== undefined
          }
          data-testid="mcp-enabled"
          onChange={(on) => {
            if (on) setConfirming('enabled');
            else apply('enabled', false);
          }}
        />
        <SwitchRow
          nested
          label={t('mcp.policy.writes')}
          hint={t(mcp.enabled ? 'mcp.policy.writesHint' : 'mcp.policy.writesNeedsMcp')}
          checked={mcp.allow_writes}
          disabled={save.isPending || !mcp.enabled}
          pending={
            save.isPending && confirming === null && save.variables.mcp?.allow_writes !== undefined
          }
          data-testid="mcp-allow-writes"
          onChange={(on) => {
            if (on) setConfirming('allow_writes');
            else apply('allow_writes', false);
          }}
        />
        {save.isError && confirming === null ? <ErrorAlert error={save.error} /> : null}
      </div>
      {confirming === null ? null : (
        <Dialog
          open
          role="alertdialog"
          layout="sheet"
          className="max-w-lg"
          onOpenChange={(next) => {
            if (!next) close();
          }}
          title={t(`mcp.policy.confirm.${confirming}.title`)}
          closeLabel={t('page.close')}
        >
          <div className="flex flex-col gap-4" data-testid={`mcp-confirm-${confirming}`}>
            <div className="flex flex-col gap-2 text-body text-fg">
              <p>{t(`mcp.policy.confirm.${confirming}.lead`)}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                <li>{t(`mcp.policy.confirm.${confirming}.point1`)}</li>
                <li>{t(`mcp.policy.confirm.${confirming}.point2`)}</li>
                <li>{t(`mcp.policy.confirm.${confirming}.point3`)}</li>
              </ul>
            </div>
            {save.isError ? <ErrorAlert error={save.error} /> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" disabled={save.isPending} onClick={close}>
                {t('page.cancel')}
              </Button>
              <Button
                disabled={save.isPending}
                data-testid="mcp-confirm"
                onClick={() => {
                  apply(confirming, true);
                }}
              >
                {save.isPending ? <Spinner /> : null}
                {t(`mcp.policy.confirm.${confirming}.action`)}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Section>
  );
}

/** A switch with its label and the line under it, as in the token policy form. */
function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  pending,
  nested = false,
  onChange,
  'data-testid': testId,
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly nested?: boolean;
  readonly onChange: (on: boolean) => void;
  readonly 'data-testid': string;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-3', nested && 'ml-12')}>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        data-testid={testId}
        className="mt-0.5"
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="flex items-center gap-2 text-body font-medium text-fg">
          {label}
          {pending ? <Spinner className="size-3.5 text-fg-muted" /> : null}
        </label>
        <p id={`${id}-hint`} className="text-label font-normal text-fg-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}

/**
 * The endpoint and a ready configuration for Claude Code, Cursor and VS Code
 * (research MCP §5). `token`: the value right after creation (the caller's
 * state, like the "shown once" dialog); afterwards the masked token
 * (`masked`), which the user replaces. VS Code's asks for the token itself.
 */
export function McpConnect({
  token,
  masked,
}: {
  readonly token: string;
  readonly masked: boolean;
}) {
  const { t } = useTranslation('apiTokens');
  const name = useId();
  const [client, setClient] = useState<McpClient>('claudeCode');
  const url = mcpUrl(window.location.origin);
  const snippet = mcpSnippet(client, url, token);
  return (
    <div className="flex flex-col gap-4" data-testid="mcp-connect">
      <CopyField label={t('mcp.connect.url')} value={url} data-testid="mcp-url" />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-label text-fg">{t('mcp.connect.client')}</legend>
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line-control bg-line-control">
          {MCP_CLIENTS.map((item) => (
            <label
              key={item}
              className={cn(
                'flex min-h-control cursor-pointer items-center justify-center px-2 text-center text-label leading-tight transition-colors lg:min-h-8',
                'has-[:focus-visible]:z-10 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent',
                client === item
                  ? 'bg-accent font-semibold text-on-accent'
                  : 'bg-surface text-fg hover:bg-surface-sunken',
              )}
            >
              <input
                type="radio"
                name={name}
                value={item}
                checked={client === item}
                className="sr-only"
                data-testid={`mcp-client-${item}`}
                onChange={() => {
                  setClient(item);
                }}
              />
              {t(`mcp.connect.clients.${item}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div key={client} className="animate-fade-in">
        <CopyField
          label={t(`mcp.connect.snippet.${client}`)}
          value={snippet}
          hint={t(`mcp.connect.hint.${client}`)}
          multiline
          rows={Math.min(Math.max(snippet.split('\n').length, 3), 12)}
          data-testid="mcp-snippet"
        />
      </div>
      {masked && client !== 'vscode' ? (
        <Note tone="neutral" icon={<Info />} data-testid="mcp-placeholder">
          {t('mcp.connect.placeholder', { masked: token })}
        </Note>
      ) : null}
    </div>
  );
}

/** "Connect via MCP" from a row of the token list: the snippets carry the masked token. */
export function McpConnectDialog({
  token,
  onClose,
}: {
  readonly token: ApiTokenDto | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation('apiTokens');
  return (
    <Dialog
      open={token !== null}
      layout="sheet"
      className="max-w-xl"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('mcp.connect.title')}
      description={token === null ? undefined : t('mcp.connect.description', { name: token.name })}
      closeLabel={t('page.close')}
    >
      {token === null ? null : (
        <div className="flex flex-col gap-4">
          <McpConnect key={token.id} token={maskedToken(token.token_prefix)} masked />
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              {t('page.close')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
