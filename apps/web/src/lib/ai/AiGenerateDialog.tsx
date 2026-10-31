import { Button, cn, Dialog, Spinner } from '@cellhive/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api';
import { aiApi } from '../api/ai';
import { ErrorAlert } from '../errors/ErrorAlert';
import { keys } from '../query/keys';
import { tableRecordCountQuery } from '../query/queries';
import { trackJob } from '../realtime/jobs';
import { showToast } from '../toast/toast';

import { aiConfigOf, estimateAiTokens } from './ai-field';

import type { AiFieldGenerateRequest, FieldDto } from '@cellhive/contracts';

/**
 * What the dialog asks: after saving an AI field (`save`: only empty cells,
 * all — overwriting —, or later), or one "Regenerate" of the column menu.
 */
export type AiGenerateMode = 'save' | 'empty' | 'failed' | 'all';

export interface AiGenerateDialogProps {
  readonly tableId: string;
  readonly field: FieldDto;
  readonly mode: AiGenerateMode;
  /** Tokens per row of the last preview (else the server's rough upper bound). */
  readonly perRow?: number | undefined;
  /** A field just created: every cell is empty (no count of the empty ones to ask). */
  readonly created?: boolean | undefined;
  readonly onClose: () => void;
}

type Scope = Extract<AiFieldGenerateRequest['scope'], 'empty' | 'failed' | 'all'>;

/** The empty cells of an AI field: `total` of a one-row query with `is_empty`. */
function useEmptyCount(tableId: string, fieldId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.aiEmptyCount(tableId, fieldId),
    queryFn: async ({ signal }) => {
      const page = await api.records.query(
        tableId,
        {
          limit: 1,
          fields: [],
          filter: { op: 'and', items: [{ field: fieldId, operator: 'is_empty' }] },
        },
        { signal },
      );
      return 'total' in page ? page.total : 'total_estimate' in page ? page.total_estimate : null;
    },
    enabled,
    staleTime: 0,
  });
}

/**
 * "Generate for N existing rows?" (T915, FRONTEND §4.10, research S8 §5.6,
 * CONTRACTS §29.5): a new AI field fills no existing row by itself, so the
 * dialog after saving asks — only empty cells, all cells (overwrite: the
 * old values stay in each record's history), or later — with the rows and
 * the tokens it would take. The column menu's "Regenerate" (empty, failed,
 * all) confirms the same way. `POST /fields/:id/ai/generate` → a job
 * followed in a toast (`job.progress`); the grid reloads its rows so the
 * queued cells shimmer, and again when the job ends.
 */
export function AiGenerateDialog({
  tableId,
  field,
  mode,
  perRow,
  created = false,
  onClose,
}: AiGenerateDialogProps) {
  const { t } = useTranslation(['field', 'common']);
  const queryClient = useQueryClient();
  const name = useId();
  const [scope, setScope] = useState<Scope>(mode === 'save' ? 'empty' : mode);
  const config = aiConfigOf(field);
  const all = useQuery(tableRecordCountQuery(tableId));
  const needsEmpty = !created && (mode === 'save' || mode === 'empty');
  const empty = useEmptyCount(tableId, field.id, needsEmpty);
  const counts: Readonly<Record<Scope, number | undefined>> = {
    all: all.data?.count,
    empty: created ? all.data?.count : (empty.data ?? undefined),
    failed: field.ai_state?.failed ?? 0,
  };
  const tokensOf = (count: number | undefined) =>
    count === undefined || config === null ? undefined : estimateAiTokens(count, config, perRow);

  const generate = useMutation({
    mutationFn: (chosen: Scope) => aiApi.generateField(field.id, { scope: chosen }),
    onSuccess: (result) => {
      onClose();
      if (result.rows === 0) {
        showToast({ variant: 'info', message: t('field:ai.generate.nothing') });
        return;
      }
      const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: keys.recordBlocks(tableId) });
        void queryClient.invalidateQueries({ queryKey: keys.fields(tableId) });
      };
      // The queued cells shimmer now; values arrive by `record.updated`, states with the job.
      refresh();
      trackJob(result.job_id, {
        messages: {
          running: t('field:ai.generate.running', { name: field.name, count: result.rows }),
          succeeded: t('field:ai.generate.succeeded', { name: field.name }),
          failed: t('field:ai.generate.failed', { name: field.name }),
        },
        onSettled: refresh,
      });
    },
  });

  const count = counts[scope];
  const tokens = tokensOf(count);
  const overwrite = scope === 'all' && !created;
  const title =
    mode === 'save'
      ? count === undefined
        ? t('field:ai.generate.titleSave')
        : t('field:ai.generate.titleSaveCount', { count: counts.all ?? count })
      : t(`field:ai.generate.title.${mode}`, { name: field.name });

  const choice = (value: 'empty' | 'all') => {
    const rows = counts[value];
    const estimate = tokensOf(rows);
    return (
      <label
        key={value}
        data-testid={`ai-generate-${value}`}
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface p-3',
          'transition-[border-color,background-color] duration-(--motion-enter) hover:border-line-strong',
          'has-[:checked]:border-accent has-[:checked]:bg-accent-soft',
          'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent',
        )}
      >
        <input
          type="radio"
          name={name}
          className="mt-0.5 size-4 shrink-0"
          checked={scope === value}
          onChange={() => {
            setScope(value);
          }}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-body font-medium text-fg">
            {t(value === 'empty' ? 'field:ai.generate.empty' : 'field:ai.generate.all')}
          </span>
          <span className="text-label font-normal text-fg-muted">
            {rows === undefined
              ? t('field:ai.generate.counting')
              : estimate === undefined
                ? t('field:ai.generate.rows', { count: rows })
                : t('field:ai.generate.rowsTokens', { count: rows, tokens: estimate })}
          </span>
          {value === 'all' && !created ? (
            <span className="text-label font-normal text-fg-muted">
              {t('field:ai.generate.overwriteNote')}
            </span>
          ) : null}
        </span>
      </label>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-accent" />
          {title}
        </span>
      }
      description={
        mode === 'save'
          ? t(
              config?.auto_update === false
                ? 'field:ai.generate.descriptionManual'
                : 'field:ai.generate.description',
            )
          : undefined
      }
      closeLabel={t('common:actions.close')}
      className="max-w-lg"
      layout="sheet"
    >
      <div className="flex flex-col gap-4" data-testid="ai-generate-dialog">
        {mode === 'save' ? (
          <div
            role="radiogroup"
            aria-label={t('field:ai.generate.which')}
            className="flex flex-col gap-2"
          >
            {choice('empty')}
            {choice('all')}
          </div>
        ) : (
          <p className="text-body text-fg" data-testid="ai-generate-summary">
            {count === undefined
              ? t('field:ai.generate.counting')
              : tokens === undefined
                ? t('field:ai.generate.rows', { count })
                : t('field:ai.generate.rowsTokens', { count, tokens })}
          </p>
        )}
        {overwrite && mode !== 'save' ? (
          <p
            role="note"
            className="flex items-start gap-2 rounded-lg border border-warning/50 bg-option-3 px-3 py-2.5 text-label font-normal text-fg"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            {t('field:ai.generate.overwriteNote')}
          </p>
        ) : null}
        <p className="text-label font-normal text-fg-muted">{t('field:ai.generate.quotaNote')}</p>
        {generate.error === null ? null : <ErrorAlert error={generate.error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} data-testid="ai-generate-later">
            {mode === 'save' ? t('field:ai.generate.later') : t('common:actions.cancel')}
          </Button>
          <Button
            variant={overwrite ? 'danger' : 'primary'}
            disabled={generate.isPending || count === 0}
            data-testid="ai-generate-confirm"
            onClick={() => {
              generate.mutate(scope);
            }}
          >
            {generate.isPending ? <Spinner /> : <Sparkles aria-hidden="true" />}
            {mode === 'save'
              ? overwrite
                ? t('field:ai.generate.confirmOverwrite')
                : t('field:ai.generate.confirm')
              : t('field:ai.generate.confirmRegenerate')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export default AiGenerateDialog;
