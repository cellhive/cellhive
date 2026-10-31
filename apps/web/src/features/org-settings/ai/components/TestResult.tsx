import { parseAllowlistPattern, type AiSettingsTestResult } from '@cellhive/contracts';
import { Button, Dialog, FormField, Input, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { showToast } from '../../../../lib/toast/toast';
import { NoteBox } from '../../email/components/SettingsSection';
import { allowlistQuery, httpAllowlistApi, integrationKeys } from '../../integrations/api';
import { allowlistPatternOf, displayHostOf, testViewOf } from '../model';

/**
 * "Allow host:port" (CONTRACTS §25.4): the entry prefilled, editable, then
 * the test runs again. Rendered outside the result's live region.
 */
export function AllowDialog({
  orgId,
  orgName,
  pattern: prefilled,
  onClose,
  onAdded,
}: {
  readonly orgId: string;
  readonly orgName: string;
  readonly pattern: string;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const { t } = useTranslation('orgAi');
  const queryClient = useQueryClient();
  const [pattern, setPattern] = useState(prefilled);
  const [note, setNote] = useState(() => t('allow.noteValue'));
  const parsed = parseAllowlistPattern(pattern);
  const add = useMutation({
    mutationFn: () =>
      httpAllowlistApi.create(orgId, { pattern: pattern.trim(), note: note.trim() }),
    onSuccess: async (entry) => {
      await queryClient.invalidateQueries({ queryKey: integrationKeys.allowlist(orgId) });
      showToast({ variant: 'success', message: t('allow.added', { pattern: entry.pattern }) });
      onAdded();
    },
  });
  return (
    <Dialog
      open
      layout="sheet"
      className="max-w-lg"
      onOpenChange={(next) => {
        if (!next && !add.isPending) onClose();
      }}
      title={t('allow.title', { pattern: prefilled })}
      description={t('allow.description', { org: orgName })}
      closeLabel={t('close')}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        data-testid="ai-allow-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed !== null && !add.isPending) add.mutate();
        }}
      >
        <FormField
          label={t('allow.pattern')}
          error={parsed === null ? t('allow.invalid') : undefined}
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              data-testid="ai-allow-pattern"
              value={pattern}
              onChange={(event) => {
                setPattern(event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField label={t('allow.note')}>
          {(control) => (
            <Input
              {...control}
              maxLength={200}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </FormField>
        {add.isError ? <ErrorAlert error={add.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={add.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            disabled={parsed === null || add.isPending}
            data-testid="ai-allow-confirm"
          >
            {add.isPending ? <Spinner /> : null}
            {t('allow.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The address may not be called (`ssrf_blocked`): what the allowlist can
 * do about it — offer the `host:port` entry, or say why it would not help
 * (an IP address, the instance keeps internal addresses closed, already
 * allowed).
 */
function BlockedNote({
  orgId,
  baseUrl,
  onAllow,
}: {
  readonly orgId: string;
  readonly baseUrl: string;
  readonly onAllow: (pattern: string) => void;
}) {
  const { t } = useTranslation('orgAi');
  const { orgSlug = '' } = useParams();
  const pattern = allowlistPatternOf(baseUrl);
  const allowlist = useQuery(allowlistQuery(orgId, pattern !== null));
  const host = displayHostOf(baseUrl) ?? baseUrl;
  const already = allowlist.data?.items.some((entry) => entry.pattern === pattern) === true;
  const closed = allowlist.data?.private_addresses === 'off';
  let advice: string | null = null;
  if (pattern === null) advice = t('test.blocked.ip');
  else if (closed) advice = t('test.blocked.off');
  else if (already) advice = t('test.blocked.already', { pattern });
  return (
    <NoteBox
      tone="warning"
      icon={<ShieldAlert />}
      title={t('test.blocked.title', { host })}
      data-testid="ai-test-blocked"
    >
      <span className="flex flex-col items-start gap-2">
        <span>{advice ?? t('test.blocked.body')}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {pattern === null || advice !== null || allowlist.data === undefined ? null : (
            <Button
              variant="secondary"
              data-testid="ai-allow"
              onClick={() => {
                onAllow(pattern);
              }}
            >
              {t('test.blocked.allow', { pattern })}
            </Button>
          )}
          <Link
            to={`/o/${encodeURIComponent(orgSlug)}/settings/integrations`}
            className="text-label font-normal text-accent underline underline-offset-4"
          >
            {t('test.blocked.integrations')}
          </Link>
        </span>
      </span>
    </NoteBox>
  );
}

/** The outcome of "Test connection" (CONTRACTS §29.1): what was found, or why it failed and what to do. */
export function TestResult({
  orgId,
  result,
  baseUrl,
  model,
  onAllow,
}: {
  readonly orgId: string;
  readonly result: AiSettingsTestResult;
  readonly baseUrl: string;
  readonly model: string;
  readonly onAllow: (pattern: string) => void;
}) {
  const { t } = useTranslation('orgAi');
  const view = testViewOf(result);
  const host = displayHostOf(baseUrl) ?? baseUrl;
  if (view.blocked) {
    return (
      <div className="motion-safe:animate-reveal">
        <BlockedNote orgId={orgId} baseUrl={baseUrl} onAllow={onAllow} />
      </div>
    );
  }
  if (!view.ok) {
    const status = result.error?.status ?? null;
    return (
      <div className="motion-safe:animate-reveal">
        <NoteBox
          tone="danger"
          icon={<CircleX />}
          title={t(`test.failure.${view.failure ?? 'unknown'}`)}
          data-testid="ai-test-failed"
        >
          {t(`test.failure.${view.failure ?? 'unknown'}Hint`)}
          {status === null ? null : (
            <>
              {' '}
              <span className="rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-mono whitespace-nowrap">
                {t('test.httpStatus', { status })}
              </span>
            </>
          )}
        </NoteBox>
      </div>
    );
  }
  const format = result.structured_output;
  return (
    <div className="motion-safe:animate-reveal">
      <NoteBox
        tone="success"
        icon={<CircleCheck />}
        title={t('test.ok', { host })}
        data-testid="ai-test-ok"
      >
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt className="text-fg-muted">{t('test.model')}</dt>
          <dd className="font-mono text-mono break-all">{model}</dd>
          <dt className="text-fg-muted">{t('test.format')}</dt>
          <dd data-testid="ai-test-format">
            {format === null ? '—' : t(`limits.formats.${format}`)}
          </dd>
          <dt className="text-fg-muted">{t('test.latency')}</dt>
          <dd className="tabular-nums" data-testid="ai-test-latency">
            {t('test.latencyValue', { ms: result.latency_ms })}
          </dd>
          <dt className="text-fg-muted">{t('test.models')}</dt>
          <dd className="tabular-nums">
            {result.models === null ? t('test.modelsNone') : result.models.length}
          </dd>
        </dl>
      </NoteBox>
    </div>
  );
}
