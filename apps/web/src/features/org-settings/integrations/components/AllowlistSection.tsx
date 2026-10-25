import { HTTP_ALLOWLIST_MAX_ENTRIES, type HttpAllowlistEntryDto } from '@cellhive/contracts';
import { Button, FormField, Input, Skeleton, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../../lib/i18n/format';
import { showToast } from '../../../../lib/toast/toast';
import { allowlistQuery, httpAllowlistApi, integrationKeys } from '../api';
import { allowlistPreview } from '../model';

import { ConfirmDialog, Note } from './parts';

/** An example pattern (not translated). */
const PATTERN_EXAMPLE = 'n8n.internal:5678';

/**
 * "HTTP allowlist" (BACKLOG T613, CONTRACTS §25.4, "Quyết định S5c" #6):
 * hosts automations may call on a private network or another port — exact
 * or `*.suffix`, optional `:port`, never an IP. What it opens is explained
 * (cloud metadata never; `HTTP_PRIVATE_ALLOWLIST=off` → ports only). Add
 * inline, remove after a confirmation.
 */
export function AllowlistSection({ orgId }: { readonly orgId: string }) {
  const { t } = useTranslation('orgIntegrations');
  const format = useFormatters();
  const queryClient = useQueryClient();
  const id = useId();
  const list = useQuery(allowlistQuery(orgId, orgId !== ''));
  const [pattern, setPattern] = useState('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [removing, setRemoving] = useState<HttpAllowlistEntryDto | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: integrationKeys.allowlist(orgId) });
  };
  const add = useMutation({
    mutationFn: () =>
      httpAllowlistApi.create(orgId, { pattern: pattern.trim(), note: note.trim() }),
    onSuccess: (entry) => {
      setPattern('');
      setNote('');
      setSubmitted(false);
      refresh();
      showToast({
        variant: 'success',
        message: t('allowlist.toast.added', { pattern: entry.pattern }),
      });
    },
  });
  const remove = useMutation({
    mutationFn: (entry: HttpAllowlistEntryDto) => httpAllowlistApi.remove(entry.id),
    onSuccess: (_result, entry) => {
      setRemoving(null);
      refresh();
      showToast({
        variant: 'success',
        message: t('allowlist.toast.removed', { pattern: entry.pattern }),
      });
    },
  });
  const preview = allowlistPreview(pattern);
  const patternError =
    submitted && preview === null
      ? pattern.trim() === ''
        ? t('allowlist.error.required')
        : t('allowlist.error.pattern')
      : undefined;
  const items = list.data?.items ?? [];
  const full = items.length >= HTTP_ALLOWLIST_MAX_ENTRIES;
  const off = list.data?.private_addresses === 'off';

  return (
    <section
      id="allowlist"
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
      data-testid="allowlist-section"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-heading">
          {t('allowlist.title')}
        </h2>
        <p className="max-w-[70ch] text-body text-fg-muted">{t('allowlist.intro')}</p>
      </div>
      <Note tone="neutral" icon={<ShieldCheck />} title={t('allowlist.rulesTitle')}>
        <ul className="list-disc pl-4">
          <li>{t('allowlist.rules.patterns')}</li>
          <li>{t('allowlist.rules.ports')}</li>
          <li>{t('allowlist.rules.loopback')}</li>
          <li>{t('allowlist.rules.never')}</li>
        </ul>
      </Note>
      {off ? (
        <Note
          tone="warning"
          icon={<TriangleAlert />}
          title={t('allowlist.offTitle')}
          data-testid="allowlist-off"
        >
          {t('allowlist.off')}
        </Note>
      ) : null}

      <form
        className="flex flex-col gap-3 rounded-md border border-line bg-surface-sunken/40 p-3"
        noValidate
        aria-labelledby={`${id}-add`}
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (preview !== null && !full) add.mutate();
        }}
      >
        <h3 id={`${id}-add`} className="text-label font-semibold text-fg">
          {t('allowlist.addTitle')}
        </h3>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FormField
            label={t('allowlist.pattern')}
            hint={
              preview !== null && preview.pattern !== pattern.trim()
                ? t('allowlist.savedAs', { pattern: preview.pattern })
                : t('allowlist.patternHint')
            }
            error={patternError}
          >
            {(control) => (
              <Input
                {...control}
                value={pattern}
                placeholder={PATTERN_EXAMPLE}
                autoComplete="off"
                spellCheck={false}
                className="font-code"
                data-testid="allowlist-pattern"
                onChange={(event) => {
                  setPattern(event.target.value);
                }}
              />
            )}
          </FormField>
          <FormField label={t('allowlist.note')} hint={t('allowlist.noteHint')}>
            {(control) => (
              <Input
                {...control}
                value={note}
                maxLength={200}
                autoComplete="off"
                data-testid="allowlist-note"
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </FormField>
        </div>
        {add.isError ? <ErrorAlert error={add.error} /> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={add.isPending || full} data-testid="allowlist-add">
            {add.isPending ? <Spinner /> : <Plus aria-hidden="true" />}
            {t('allowlist.add')}
          </Button>
          <span className="text-label font-normal text-fg-muted">
            {t('allowlist.count', { count: items.length, max: HTTP_ALLOWLIST_MAX_ENTRIES })}
          </span>
        </div>
      </form>

      {list.isPending ? (
        <div role="status" aria-busy="true" aria-label={t('page.loading')}>
          <Skeleton className="h-12" />
        </div>
      ) : list.isError ? (
        <ErrorAlert error={list.error} />
      ) : items.length === 0 ? (
        <p className="text-body text-fg-muted" data-testid="allowlist-empty">
          {t('allowlist.empty')}
        </p>
      ) : (
        <ul
          aria-label={t('allowlist.listLabel')}
          className="flex flex-col rounded-md border border-line"
          data-testid="allowlist-list"
        >
          {items.map((entry) => (
            <li
              key={entry.id}
              data-testid="allowlist-row"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-2.5 first:border-t-0"
            >
              <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                <code className="font-code text-body break-all text-fg">{entry.pattern}</code>
                <span className="text-label font-normal text-fg-muted">
                  {entry.port === null
                    ? t('allowlist.ports.default')
                    : t('allowlist.ports.one', { port: entry.port })}
                  {entry.wildcard ? ` · ${t('allowlist.wildcard')}` : ''}
                </span>
                {entry.note === '' ? null : (
                  <span className="text-label font-normal break-words text-fg">{entry.note}</span>
                )}
                <span className="text-label font-normal text-fg-muted">
                  {t('allowlist.addedBy', {
                    name: entry.created_by?.name ?? t('page.unknownUser'),
                    date: format.dateTime(entry.created_at),
                  })}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="max-lg:size-control"
                aria-label={t('allowlist.remove', { pattern: entry.pattern })}
                data-testid="allowlist-remove"
                onClick={() => {
                  remove.reset();
                  setRemoving(entry);
                }}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t('allowlist.removeTitle', { pattern: removing?.pattern ?? '' })}
        description={t('allowlist.removeDescription')}
        confirmLabel={t('allowlist.removeConfirm')}
        pending={remove.isPending}
        error={remove.isError ? remove.error : undefined}
        data-testid="allowlist-remove-dialog"
        onCancel={() => {
          setRemoving(null);
        }}
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing);
        }}
      />
    </section>
  );
}
