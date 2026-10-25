import {
  userChannel,
  type AutomationTrigger,
  type Id,
  type IncomingWebhookList,
  type IncomingWebhookSampleResponse,
  type IncomingWebhookWithSecretsDto,
} from '@cellhive/contracts';
import { Button, Select, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clock, Ear, EarOff, ExternalLink, Info, Plus, Radio } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ErrorAlert } from '../../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../../lib/i18n/format';
import {
  incomingWebhookKeys,
  incomingWebhooksQuery,
} from '../../../../../lib/query/incoming-webhooks';
import { useRealtimeChannel } from '../../../../../lib/realtime/channels';
import { useBuilderEnv } from '../../components/env';
import { Note, PanelField } from '../../components/panels/common';
import { isUnset } from '../../model/draft';

import { webhookSampleApi } from './api';
import { countdownText, LISTEN_SECONDS, listenState, sampleTree, type SampleNode } from './model';
import { sampleKey, sampleQuery } from './queries';
import { SamplePath } from './SamplePath';
import { SampleTree } from './SampleTree';

type WebhookTrigger = Extract<AutomationTrigger, { type: 'webhook.received' }>;

export interface WebhookTriggerEditorProps {
  readonly trigger: WebhookTrigger;
  readonly onChange: (trigger: AutomationTrigger) => void;
}

/** Ticks once a second until `until` (ms) has passed; `null`: no clock. */
function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    let timer = 0;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current > until) window.clearInterval(timer);
    };
    const first = window.setTimeout(tick, 0);
    timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [until]);
  return now;
}

const PATH = 'incoming_webhook_id';
/** Test ids of the notes (the `Note` of the builder takes them as `testId`). */
const TEST_IDS = { gone: 'webhook-trigger-gone', off: 'webhook-trigger-off' } as const;

/**
 * Settings of the `webhook.received` trigger (BACKLOG T612, F§13.2;
 * CONTRACTS §21, §25.3): the incoming webhook of the base (or "New webhook",
 * the dialog of T611 with its secrets shown once), its URL, and "Listen for a
 * sample request" — 3-minute countdown, `incoming_webhook.sample_captured` on
 * `user:<me>` (read again when the window gets the focus back), stop — then
 * the sample as a tree whose paths the "+" menu of every value offers under
 * "Webhook data". Base admins only (the trigger is not offered to others).
 */
export default function WebhookTriggerEditor({ trigger, onChange }: WebhookTriggerEditorProps) {
  // `incomingWebhooks` is loaded with the editor: the dialogs of T611 use it.
  const { t } = useTranslation(['automationBuilder', 'incomingWebhooks']);
  const env = useBuilderEnv();
  const baseId = env.base.id;
  const queryClient = useQueryClient();
  const hooks = useQuery(incomingWebhooksQuery(baseId));
  const { CreateWebhookDialog, SecretRevealDialog, CopyField } = env.webhookKit;
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState<IncomingWebhookWithSecretsDto | null>(null);
  /** A created hook goes into the list at once (never its secrets), then the list is read again. */
  const put = (created: IncomingWebhookWithSecretsDto) => {
    const stored: Partial<IncomingWebhookWithSecretsDto> = { ...created };
    delete stored.signing_secret;
    delete stored.bearer_token;
    queryClient.setQueryData<IncomingWebhookList>(incomingWebhookKeys.list(baseId), (list) =>
      list === undefined
        ? list
        : {
            items: [
              ...list.items.filter((item) => item.id !== created.id),
              stored as IncomingWebhookList['items'][number],
            ],
          },
    );
    void queryClient.invalidateQueries({ queryKey: incomingWebhookKeys.list(baseId), exact: true });
  };
  const hookId = isUnset(trigger.incoming_webhook_id) ? null : trigger.incoming_webhook_id;
  const items = hooks.data?.items ?? [];
  const hook = items.find((item) => item.id === hookId) ?? null;

  const create = (
    <Button
      variant="secondary"
      data-testid="webhook-trigger-create"
      onClick={() => {
        setCreating(true);
      }}
    >
      <Plus aria-hidden="true" />
      {t('webhook.create')}
    </Button>
  );

  let body: ReactNode;
  if (hooks.isError) {
    body = <ErrorAlert error={hooks.error} />;
  } else if (hooks.data === undefined) {
    body = (
      <div role="status" aria-busy="true" aria-label={t('webhook.loading')}>
        <Skeleton className="h-control" />
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="flex flex-col items-start gap-2" data-testid="webhook-trigger-empty">
        <p className="text-body text-fg">{t('webhook.noHooks')}</p>
        <p className="text-label font-normal text-fg-muted">{t('webhook.noHooksHint')}</p>
        {create}
      </div>
    );
  } else {
    body = (
      <>
        <PanelField label={t('webhook.hook')} step="trigger" path={PATH}>
          {(control) => (
            <div className="flex min-w-0 flex-wrap gap-2">
              <Select
                {...control}
                className="min-w-0 flex-1 basis-48"
                value={hookId ?? ''}
                data-testid="webhook-trigger-hook"
                onChange={(event) => {
                  onChange({
                    ...trigger,
                    incoming_webhook_id: event.target.value as `hok_${string}`,
                  });
                }}
              >
                <option value="">{t('values.choose')}</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.enabled ? item.name : t('webhook.hookOff', { name: item.name })}
                  </option>
                ))}
                {hookId !== null && hook === null ? (
                  <option value={hookId}>{t('webhook.unknownHook')}</option>
                ) : null}
              </Select>
              {create}
            </div>
          )}
        </PanelField>
        {hookId !== null && hook === null ? (
          <Note tone="danger" testId={TEST_IDS.gone}>
            {t('webhook.hookGone')}
          </Note>
        ) : null}
        {hook === null ? null : (
          <>
            {hook.enabled ? null : (
              <Note tone="warning" testId={TEST_IDS.off}>
                {t('webhook.hookOffNote')}
              </Note>
            )}
            <CopyField
              label={t('webhook.url')}
              value={hook.url}
              data-testid="webhook-trigger-url"
            />
            <Link
              to={`/b/${encodeURIComponent(baseId)}/settings/webhooks?hook=${encodeURIComponent(hook.id)}`}
              className="inline-flex items-center gap-1 self-start text-label text-accent underline-offset-2 hover:underline"
              data-testid="webhook-trigger-manage"
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
              {t('webhook.manage')}
            </Link>
            <SampleSection key={hook.id} baseId={baseId} hookId={hook.id} meId={env.meId} />
          </>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="webhook-trigger">
      {body}
      <CreateWebhookDialog
        baseId={baseId}
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onCreated={(created) => {
          setCreating(false);
          put(created);
          // The new hook is the trigger's; its secrets are shown once first.
          onChange({ ...trigger, incoming_webhook_id: created.id });
          setReveal(created);
        }}
      />
      <SecretRevealDialog
        reveal={reveal === null ? null : { reason: 'created', hook: reveal }}
        onDone={() => {
          setReveal(null);
        }}
      />
    </div>
  );
}

function SampleSection({
  baseId,
  hookId,
  meId,
}: {
  readonly baseId: string;
  readonly hookId: string;
  readonly meId: string | null;
}) {
  const { t } = useTranslation('automationBuilder');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const headingId = useId();
  const sample = useQuery(sampleQuery(baseId, hookId));
  // When the window closes (ms), as this screen knows it; `startedHere`: this screen opened it.
  const [deadline, setDeadline] = useState<number | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const [selected, setSelected] = useState<SampleNode | null>(null);
  const serverUntil = sample.data?.listen_until ?? null;
  // A window opened elsewhere (another tab, before a reload) counts from the server's time.
  const effectiveDeadline = deadline ?? (serverUntil === null ? null : Date.parse(serverUntil));
  const now = useNow(effectiveDeadline);
  const state = listenState({
    sample: sample.data?.sample ?? null,
    deadline: effectiveDeadline,
    startedHere,
    now,
  });
  const nodes = useMemo(
    () => (sample.data?.sample == null ? null : sampleTree(sample.data.sample)),
    [sample.data],
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: sampleKey(baseId, hookId) });
  };
  useRealtimeChannel(meId === null ? null : userChannel(meId as Id<'usr'>), {
    onMessage: (message) => {
      if (message.type !== 'incoming_webhook.sample_captured') return;
      if (message.incoming_webhook_id !== hookId) return;
      setDeadline(null);
      setSelected(null);
      refresh();
      void queryClient.invalidateQueries({
        queryKey: incomingWebhookKeys.list(baseId),
        exact: true,
      });
    },
    onReconnect: refresh,
  });
  // The window just ran out: read once more (a request may have won at the last second).
  const expiredNow = state.kind !== 'listening' && deadline !== null && deadline <= now;
  useEffect(() => {
    if (expiredNow) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per expiry
  }, [expiredNow]);

  const listen = useMutation({
    mutationFn: () => webhookSampleApi.listen(hookId),
    onSuccess: (answer) => {
      // Counted from now: the server's clock may differ from this one.
      setDeadline(Date.now() + LISTEN_SECONDS * 1000);
      setStartedHere(true);
      setSelected(null);
      queryClient.setQueryData<IncomingWebhookSampleResponse>(sampleKey(baseId, hookId), {
        sample: null,
        listen_until: answer.listen_until,
      });
    },
  });
  const stop = useMutation({
    mutationFn: () => webhookSampleApi.stop(hookId),
    onSuccess: () => {
      setDeadline(null);
      setStartedHere(false);
      queryClient.setQueryData<IncomingWebhookSampleResponse>(
        sampleKey(baseId, hookId),
        (current) => (current === undefined ? current : { ...current, listen_until: null }),
      );
    },
  });

  // Only state changes are announced; the countdown itself is not (it ticks every second).
  const announcement =
    state.kind === 'listening'
      ? t('webhook.listen.announceListening')
      : state.kind === 'captured'
        ? t('webhook.listen.announceCaptured')
        : state.kind === 'expired'
          ? t('webhook.listen.announceExpired')
          : '';

  let status: ReactNode;
  switch (state.kind) {
    case 'listening':
      status = (
        <div className="flex items-start gap-2" data-testid="webhook-listen-waiting">
          <Radio aria-hidden="true" className="mt-0.5 size-4 shrink-0 animate-pulse text-accent" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium text-fg">{t('webhook.listen.waiting')}</span>
            <span className="text-label font-normal text-fg-muted">
              {t('webhook.listen.sendNow')}
            </span>
            <span
              className="text-label font-normal text-fg-muted"
              data-testid="webhook-listen-countdown"
            >
              <Clock aria-hidden="true" className="mr-1 inline size-3.5 align-[-2px]" />
              {t('webhook.listen.left', { time: countdownText(state.secondsLeft) })}
            </span>
          </div>
        </div>
      );
      break;
    case 'captured':
      status = (
        <p
          className="flex items-start gap-2 text-body text-fg"
          data-testid="webhook-listen-captured"
        >
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          <span>{t('webhook.listen.captured', { time: format.dateTime(state.receivedAt) })}</span>
        </p>
      );
      break;
    case 'expired':
      status = (
        <p
          className="flex items-start gap-2 text-body text-fg"
          data-testid="webhook-listen-expired"
        >
          <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
          <span>{t('webhook.listen.expired')}</span>
        </p>
      );
      break;
    case 'idle':
      status = (
        <p className="text-label font-normal text-fg-muted" data-testid="webhook-listen-idle">
          {t('webhook.listen.idle')}
        </p>
      );
      break;
  }

  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby={headingId}
      data-testid="webhook-sample"
    >
      <h3 id={headingId} className="text-label text-fg">
        {t('webhook.listen.title')}
      </h3>
      <Note>{t('webhook.listen.runsNote')}</Note>
      {sample.isError ? <ErrorAlert error={sample.error} /> : null}
      {sample.data === undefined && !sample.isError ? (
        <Skeleton className="h-12" />
      ) : (
        <>
          {status}
          <span role="status" className="sr-only">
            {announcement}
          </span>
          <div className="flex flex-wrap gap-2">
            {state.kind === 'listening' ? (
              <Button
                variant="secondary"
                data-testid="webhook-listen-stop"
                disabled={stop.isPending}
                onClick={() => {
                  stop.mutate();
                }}
              >
                {stop.isPending ? <Spinner /> : <EarOff aria-hidden="true" />}
                {t('webhook.listen.stop')}
              </Button>
            ) : (
              <Button
                data-testid="webhook-listen-start"
                disabled={listen.isPending}
                onClick={() => {
                  listen.mutate();
                }}
              >
                {listen.isPending ? <Spinner /> : <Ear aria-hidden="true" />}
                {state.kind === 'idle' ? t('webhook.listen.start') : t('webhook.listen.again')}
              </Button>
            )}
          </div>
          {listen.isError ? <ErrorAlert error={listen.error} /> : null}
          {stop.isError ? <ErrorAlert error={stop.error} /> : null}
          {nodes === null || state.kind === 'listening' ? null : (
            <div className="flex flex-col gap-2">
              <SampleTree
                nodes={nodes}
                label={t('webhook.tree')}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
              />
              {sample.data?.sample?.truncated === true ? (
                <TruncatedBody text={sample.data.sample.body} />
              ) : null}
              {selected === null ? (
                <p className="flex items-start gap-1.5 text-label font-normal text-fg-muted">
                  <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  {t('webhook.pickHint')}
                </p>
              ) : (
                <SamplePath node={selected} />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TruncatedBody({ text }: { readonly text: unknown }) {
  const { t } = useTranslation('automationBuilder');
  const id = useId();
  return (
    <div className="flex flex-col gap-1" data-testid="webhook-sample-truncated">
      <p id={id} className="text-label font-normal text-fg-muted">
        {t('webhook.truncatedNote')}
      </p>
      <pre
        tabIndex={0}
        aria-labelledby={id}
        className="max-h-40 overflow-auto rounded-md border border-line bg-surface-sunken p-2 font-mono text-mono break-all whitespace-pre-wrap text-fg"
      >
        {typeof text === 'string' ? text : JSON.stringify(text)}
      </pre>
    </div>
  );
}
