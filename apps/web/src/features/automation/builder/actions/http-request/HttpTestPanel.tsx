import {
  HTTP_DELIVERY_MAX_ATTEMPTS,
  httpRequestConfigSchema,
  runN8nWorkflowConfigSchema,
  type HttpDeliveryResult,
  type AutomationDefinition,
  type HttpRequestConfig,
  type HttpTestWarning,
  type RunN8nWorkflowConfig,
} from '@cellhive/contracts';
import { Button, cn, Input, Select, Spinner } from '@cellhive/ui';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Clock, Send } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { api } from '../../../../../lib/api';
import { ErrorAlert } from '../../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../../lib/i18n/format';
import { incomingWebhooksQuery } from '../../../../../lib/query/incoming-webhooks';
import { useBuilderEnv } from '../../components/env';
import { Note } from '../../components/panels/common';
import { hasTriggerRecord } from '../../model/draft';

import { httpTestApi } from './api';
import { checkHttpRequest, responsePaths, valueAtPath } from './model';
import { useIntegrationsPath } from './parts';
import { pickResponsePath, unpickResponsePath, usePickedResponsePaths } from './response-paths';

import type { ValueScope } from '../../model/scope';
import type { TFunction } from 'i18next';

/** Test ids of the controls (E2E). */
const TEST_IDS = {
  httpTestError: 'http-test-error',
  httpTestSample: 'http-test-sample',
  httpTestNoSample: 'http-test-no-sample',
} as const;

/** Sample records listed (primary field), as the email preview (FRONTEND §13.4). */
const SAMPLE_RECORDS = 50;
const FINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);
/** How often a test delivery is read: quickly while it is being sent, slower while it waits. */
const POLL_SENDING_MS = 1_000;
const POLL_WAITING_MS = 5_000;

/** A sentence for a delivery error code (CONTRACTS §21, §25.4–25.5). */
export function deliveryErrorText(
  t: TFunction<'automationHttp'>,
  error: {
    readonly code: string;
    readonly params?: Readonly<Record<string, unknown>> | undefined;
  },
): string {
  const params = error.params ?? {};
  switch (error.code) {
    case 'ssrf_blocked': {
      const reason = typeof params['reason'] === 'string' ? params['reason'] : 'unknown';
      return t(`error.ssrf.${reason}` as 'error.ssrf.unknown', {
        defaultValue: t('error.ssrf.unknown'),
      });
    }
    case 'http_status':
      return t('error.http_status', {
        status: typeof params['status'] === 'number' ? params['status'] : '',
      });
    case 'rate_limited':
      return t('error.rate_limited', { seconds: Number(params['retry_after_s'] ?? 0) });
    case 'secret_host_not_allowed':
      // T701: the URL's host is not an allowed host of the secret (or a legacy one expired).
      return t(
        params['reason'] === 'legacy_expired'
          ? 'error.secret_host_not_allowed_legacy_expired'
          : 'error.secret_host_not_allowed',
      );
    case 'http_timeout':
    case 'http_network':
    case 'http_response_too_large':
    case 'http_request_too_large':
    case 'secret_unavailable':
    case 'invalid_value':
      return t(`error.${error.code}`);
    default:
      return t('error.unknown', { code: error.code });
  }
}

/** Whether the allowlist of the organization would let this call through. */
function needsAllowlist(error: HttpDeliveryResult['error']): boolean {
  if (error?.code !== 'ssrf_blocked') return false;
  const reason = error.params?.['reason'];
  return reason === 'private_address' || reason === 'port_not_allowed';
}

/** The step being tested: an `http_request`, or a `run_n8n_workflow` (T616). */
export type HttpTestStep =
  | { readonly type: 'http_request'; readonly config: HttpRequestConfig }
  | { readonly type: 'run_n8n_workflow'; readonly config: RunN8nWorkflowConfig };

/** The config to send, or `null` while the step is not complete. */
function sendableDraft(
  stepId: `act_${string}`,
  step: HttpTestStep,
): HttpRequestConfig | RunN8nWorkflowConfig | null {
  if (step.type === 'http_request') {
    if (checkHttpRequest(stepId, step.config).length > 0) return null;
    const parsed = httpRequestConfigSchema.safeParse(step.config);
    return parsed.success ? parsed.data : null;
  }
  const url = step.config.url;
  if ('literal' in url && typeof url.literal === 'string' && url.literal.trim() === '') return null;
  const parsed = runN8nWorkflowConfigSchema.safeParse(step.config);
  return parsed.success ? parsed.data : null;
}

export interface HttpTestPanelProps {
  readonly stepId: `act_${string}`;
  readonly step: HttpTestStep;
  readonly definition: AutomationDefinition;
  readonly scope: ValueScope;
}

/**
 * "Send a test" (BACKLOG T613, T616, CONTRACTS §25.5): the step as edited
 * (`draft`) — an `http_request`, or the payload of a `run_n8n_workflow` —
 * rendered with the caller's permissions on a sample record, sent through
 * the outbox — `202 { delivery_id }` — then the delivery is read until it
 * ends: status, response (cut at 10 KB), or the error with what to do (an
 * internal address: the organization's allowlist). Values of a JSON response
 * can be offered to later steps (`{ step, path }`). With a `webhook.received`
 * trigger the server reads the hook's captured sample; the panel says which
 * one (or that there is none).
 */
export function HttpTestPanel({ stepId, step, definition, scope }: HttpTestPanelProps) {
  const { t } = useTranslation('automationHttp');
  const env = useBuilderEnv();
  const format = useFormatters();
  const hookId =
    definition.trigger.type === 'webhook.received' ? definition.trigger.incoming_webhook_id : null;
  // Base admins only build `webhook.received` automations, so they may read the hooks.
  const hooks = useQuery({ ...incomingWebhooksQuery(env.base.id), enabled: hookId !== null });
  const sampledAt =
    hooks.data?.items.find((hook) => hook.id === hookId)?.sample_captured_at ?? null;
  const id = useId();
  const automationId = env.automationId ?? null;

  const tableId = hasTriggerRecord(definition.trigger) ? scope.triggerTableId : null;
  const primary = env.tables.find((table) => table.id === tableId)?.primary_field_id ?? null;
  const [search, setSearch] = useState('');
  const sample = useQuery({
    queryKey: ['table', tableId ?? '', 'http-test-records', primary, search.trim()] as const,
    enabled: tableId !== null && automationId !== null,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.records.query(
        tableId ?? '',
        {
          fields: primary === null ? [] : [primary],
          limit: SAMPLE_RECORDS,
          include_total: false,
          ...(search.trim() === '' ? {} : { search: search.trim() }),
        },
        { signal, cellFormat: 'text' },
      ),
  });
  const records = (sample.data?.records ?? []).map((record) => {
    const value = primary === null ? '' : record.fields[primary];
    return { id: record.id, title: typeof value === 'string' && value !== '' ? value : record.id };
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const recordId =
    tableId === null
      ? null
      : records.some((record) => record.id === chosen)
        ? chosen
        : (records[0]?.id ?? null);

  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly HttpTestWarning[]>([]);
  const send = useMutation({
    mutationFn: (draft: HttpRequestConfig | RunN8nWorkflowConfig) =>
      httpTestApi.send(automationId ?? '', stepId, { record_id: recordId, draft }),
    onSuccess: (accepted) => {
      setDeliveryId(accepted.delivery_id);
      setWarnings(accepted.warnings);
    },
  });
  const delivery = useQuery({
    queryKey: ['http-delivery', deliveryId ?? ''] as const,
    enabled: deliveryId !== null,
    queryFn: ({ signal }) => httpTestApi.delivery(deliveryId ?? '', signal),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return POLL_SENDING_MS;
      if (FINAL.has(data.status)) return false;
      return data.status === 'pending' && data.attempts > 0 ? POLL_WAITING_MS : POLL_SENDING_MS;
    },
  });

  const draft = sendableDraft(stepId, step);
  const ready = draft !== null;
  const blocked =
    automationId === null
      ? t('test.notSaved')
      : !ready
        ? t('test.incomplete')
        : tableId !== null && sample.isSuccess && search.trim() === '' && records.length === 0
          ? t('test.noRecords')
          : null;
  const result = delivery.data;
  const running = send.isPending || (result !== undefined && !FINAL.has(result.status));

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-line p-3"
      aria-labelledby={`${id}-title`}
      data-testid="http-test"
    >
      <h3 id={`${id}-title`} className="text-label font-semibold text-fg">
        {t('test.title')}
      </h3>
      <p className="text-label font-normal text-fg-muted">{t('test.hint')}</p>
      {hookId === null ? null : (
        <Note testId={TEST_IDS.httpTestSample}>
          {sampledAt === null
            ? t('test.webhookNoSample')
            : t('test.webhookSample', { time: format.dateTime(sampledAt) })}
        </Note>
      )}
      {tableId === null || automationId === null ? null : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-record`} className="text-label text-fg">
            {t('test.record')}
          </label>
          <Select
            id={`${id}-record`}
            value={recordId ?? ''}
            disabled={sample.isPending || records.length === 0}
            data-testid="http-test-record"
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {records.length === 0 ? (
              <option value="">{sample.isPending ? t('test.loading') : t('test.noMatch')}</option>
            ) : null}
            {records.map((record) => (
              <option key={record.id} value={record.id}>
                {record.title}
              </option>
            ))}
          </Select>
          <Input
            type="search"
            value={search}
            aria-label={t('test.search')}
            placeholder={t('test.search')}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Button
          variant="secondary"
          className="self-start max-lg:h-control"
          disabled={blocked !== null || running}
          aria-describedby={blocked === null ? undefined : `${id}-blocked`}
          data-testid="http-test-send"
          onClick={() => {
            if (draft === null) return;
            setDeliveryId(null);
            setWarnings([]);
            send.mutate(draft);
          }}
        >
          {running ? <Spinner /> : <Send aria-hidden="true" />}
          {t('test.send')}
        </Button>
        {blocked === null ? null : (
          <p id={`${id}-blocked`} className="text-label font-normal text-fg-muted">
            {blocked}
          </p>
        )}
      </div>
      {send.isError ? <ErrorAlert error={send.error} /> : null}
      {warnings.length > 0 ? (
        <Note tone="warning" testId={TEST_IDS.httpTestNoSample}>
          {t('test.noSampleSent')}
        </Note>
      ) : null}
      {delivery.isError ? <ErrorAlert error={delivery.error} /> : null}
      <div role="status" aria-live="polite" className="flex flex-col gap-3">
        {result === undefined ? null : <DeliveryResult stepId={stepId} result={result} />}
      </div>
    </section>
  );
}

function DeliveryResult({
  stepId,
  result,
}: {
  readonly stepId: string;
  readonly result: HttpDeliveryResult;
}) {
  const { t } = useTranslation('automationHttp');
  const integrations = useIntegrationsPath();
  const final = FINAL.has(result.status);
  const succeeded = result.status === 'succeeded';
  const Icon = !final ? Clock : succeeded ? CircleCheck : CircleAlert;
  const response = result.response;
  const headline = !final
    ? result.attempts > 0 && result.status === 'pending'
      ? t('result.retrying', { attempts: result.attempts, max: HTTP_DELIVERY_MAX_ATTEMPTS })
      : t('result.sending', { host: result.target_host })
    : succeeded
      ? t('result.succeeded', { host: result.target_host })
      : result.status === 'cancelled'
        ? t('result.cancelled')
        : t('result.failed', { host: result.target_host });
  return (
    <div className="flex flex-col gap-3" data-testid="http-test-result" data-status={result.status}>
      <p
        className={cn(
          'flex items-start gap-1.5 text-label font-medium',
          final && !succeeded ? 'text-danger' : 'text-fg',
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn('mt-0.5 size-4 shrink-0', succeeded ? 'text-success' : undefined)}
        />
        <span>{headline}</span>
      </p>
      {result.error === null ? null : (
        <Note
          tone={needsAllowlist(result.error) ? 'warning' : 'danger'}
          testId={TEST_IDS.httpTestError}
        >
          <span className="block">{deliveryErrorText(t, result.error)}</span>
          {needsAllowlist(result.error) ? (
            <span className="mt-1 block" data-testid="http-test-allowlist-hint">
              {t('result.allowlistHint', { host: result.target_host })}{' '}
              {integrations === null ? (
                t('result.askAdmin')
              ) : (
                <Link to={integrations} className="text-accent underline">
                  {t('result.openAllowlist')}
                </Link>
              )}
            </span>
          ) : null}
          <code className="mt-1 block font-code text-label text-fg-muted">{result.error.code}</code>
        </Note>
      )}
      {response === null ? null : (
        <ResponseView stepId={stepId} response={response} final={final} />
      )}
    </div>
  );
}

function ResponseView({
  stepId,
  response,
  final,
}: {
  readonly stepId: string;
  readonly response: NonNullable<HttpDeliveryResult['response']>;
  readonly final: boolean;
}) {
  const { t } = useTranslation('automationHttp');
  const id = useId();
  const picked = usePickedResponsePaths(stepId);
  const body = response.body;
  const text =
    body === null || body === undefined
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body, null, 2);
  const paths = final ? responsePaths(body) : [];
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label">
        <dt className="text-fg-muted">{t('result.status')}</dt>
        <dd className="font-code text-fg" data-testid="http-test-status">
          HTTP {response.status}
        </dd>
        <dt className="text-fg-muted">{t('result.contentType')}</dt>
        <dd className="min-w-0 font-code break-all text-fg">
          {response.headers['content-type'] ?? '—'}
        </dd>
      </dl>
      <p id={`${id}-body`} className="text-label text-fg">
        {t('result.body')}
      </p>
      {text === null ? (
        <p className="text-label font-normal text-fg-muted">{t('result.empty')}</p>
      ) : (
        <pre
          tabIndex={0}
          aria-labelledby={`${id}-body`}
          className="max-h-64 overflow-auto rounded-md border border-line bg-surface-sunken p-2 font-code text-label break-words whitespace-pre-wrap text-fg"
          data-testid="http-test-body"
        >
          {text}
        </pre>
      )}
      {response.body_truncated ? (
        <p className="text-label font-normal text-fg-muted">{t('result.truncated')}</p>
      ) : null}
      {paths.length === 0 ? null : (
        <section className="flex flex-col gap-1.5" aria-labelledby={`${id}-paths`}>
          <h4 id={`${id}-paths`} className="text-label font-semibold text-fg">
            {t('result.pathsTitle')}
          </h4>
          <p className="text-label font-normal text-fg-muted">{t('result.pathsHint')}</p>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {paths.map((path) => {
              const on = picked.includes(path);
              const value = valueAtPath(response, path);
              return (
                <li
                  key={path}
                  className="flex items-center gap-2 px-2 py-1.5"
                  data-testid="http-test-path"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <code className="truncate font-code text-label text-fg">{path}</code>
                    <span className="truncate text-label font-normal text-fg-muted">
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </span>
                  </span>
                  <Button
                    variant={on ? 'primary' : 'secondary'}
                    size="sm"
                    className="shrink-0 max-lg:h-control"
                    aria-pressed={on}
                    aria-label={t('result.usePath', { path })}
                    onClick={() => {
                      if (on) unpickResponsePath(stepId, path);
                      else pickResponsePath(stepId, path);
                    }}
                  >
                    {on ? t('result.used') : t('result.use')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
