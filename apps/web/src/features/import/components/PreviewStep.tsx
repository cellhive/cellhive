import {
  IMPORT_DELIMITERS,
  IMPORT_ENCODINGS,
  type ImportCell,
  type ImportDelimiter,
  type ImportEncoding,
  type ImportPreview,
  type ImportPreviewQuery,
  type ImportUploadDto,
} from '@cellhive/contracts';
import { Button, Checkbox, FormField, Select, Spinner } from '@cellhive/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../lib/errors/ErrorAlert';
import { useFormatters } from '../../../lib/i18n/format';
import { importsApi } from '../api';

const DELIMITER_KEYS: Record<ImportDelimiter, string> = {
  ',': 'comma',
  ';': 'semicolon',
  '\t': 'tab',
  '|': 'pipe',
};

export interface PreviewStepProps {
  readonly baseId: string;
  readonly upload: ImportUploadDto;
  readonly preview: ImportPreview;
  /** A new preview with other options: the import uses the latest one (CONTRACTS §19). */
  readonly onPreview: (preview: ImportPreview) => void;
  /** A preview request runs or failed: the wizard waits before going on. */
  readonly onLoading: (loading: boolean) => void;
  /** Replaces the preview request (tests). */
  readonly fetchPreview?: typeof importsApi.preview;
}

/** A cell of the preview as text. */
function CellText({ value }: { value: ImportCell }) {
  const { t } = useTranslation('import');
  const format = useFormatters();
  if (value === null) return null;
  if (typeof value === 'boolean') return <>{t(value ? 'preview.true' : 'preview.false')}</>;
  if (typeof value === 'number') return <>{format.number(value)}</>;
  return <>{value}</>;
}

/** The first rows of the file as a table (at most 200, CONTRACTS §19). */
export function PreviewTable({ preview }: { preview: ImportPreview }) {
  const { t } = useTranslation('import');
  const format = useFormatters();
  const caption = t('preview.caption', {
    shown: format.number(preview.rows.length),
    total: format.number(preview.total_rows),
  });
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <p className="text-label font-normal text-fg-muted">{caption}</p>
      <div
        role="region"
        aria-label={t('preview.region')}
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-md border border-line"
      >
        <table className="w-max min-w-full border-collapse text-body">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-surface-sunken">
            <tr>
              <th
                scope="col"
                className="border-b border-line px-2 py-1 text-right text-label text-fg-muted"
              >
                <span className="sr-only">{t('preview.rowNumber')}</span>
              </th>
              {preview.columns.map((column) => (
                <th
                  key={column.index}
                  scope="col"
                  className="max-w-60 truncate border-b border-line px-2 py-1 text-left text-label"
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              // Rows have no identity beyond their position.
              <tr key={index} className="odd:bg-surface even:bg-surface-sunken/50">
                <th
                  scope="row"
                  className="px-2 py-1 text-right text-label font-normal text-fg-muted tabular-nums"
                >
                  {format.number(index + 1)}
                </th>
                {preview.columns.map((column) => (
                  <td key={column.index} className="max-w-60 truncate px-2 py-1">
                    <CellText value={row[column.index] ?? null} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Step 2: how the file is read — encoding and delimiter of a CSV (detected
 * values marked), the sheet of a workbook, whether the first row holds
 * column names — and its first 200 rows. Every change asks the server for a
 * new preview; the import uses the options of the latest one.
 */
export function PreviewStep({
  baseId,
  upload,
  preview,
  onPreview,
  onLoading,
  fetchPreview = importsApi.preview,
}: PreviewStepProps) {
  const { t } = useTranslation('import');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const detected = upload.preview;
  const csv = preview.format === 'csv';

  const reload = (change: Partial<ImportPreviewQuery>) => {
    const query: ImportPreviewQuery = csv
      ? {
          encoding: preview.encoding ?? undefined,
          delimiter: preview.delimiter ?? undefined,
          header_row: preview.header_row,
          ...change,
        }
      : { sheet: preview.sheet ?? undefined, header_row: preview.header_row, ...change };
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setError(null);
    onLoading(true);
    fetchPreview(baseId, upload.id, query, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setPending(false);
        onLoading(false);
        onPreview(next);
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setPending(false);
        // The shown preview stays; going on waits until the error is read.
        setError(failure);
      },
    );
  };

  const detectedLabel = (label: string, isDetected: boolean) =>
    isDetected ? t('preview.detected', { value: label }) : label;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {csv ? (
          <>
            <FormField label={t('preview.encoding')}>
              {(control) => (
                <Select
                  {...control}
                  value={preview.encoding ?? ''}
                  disabled={pending}
                  onChange={(event) => {
                    reload({ encoding: event.target.value as ImportEncoding });
                  }}
                >
                  {IMPORT_ENCODINGS.map((encoding) => (
                    <option key={encoding} value={encoding}>
                      {detectedLabel(t(`encodings.${encoding}`), encoding === detected.encoding)}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label={t('preview.delimiter')}>
              {(control) => (
                <Select
                  {...control}
                  value={preview.delimiter ?? ''}
                  disabled={pending}
                  onChange={(event) => {
                    reload({ delimiter: event.target.value as ImportDelimiter });
                  }}
                >
                  {IMPORT_DELIMITERS.map((delimiter) => (
                    <option key={delimiter} value={delimiter}>
                      {detectedLabel(
                        t(`delimiters.${DELIMITER_KEYS[delimiter]}`),
                        delimiter === detected.delimiter,
                      )}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </>
        ) : (
          <FormField label={t('preview.sheet')}>
            {(control) => (
              <Select
                {...control}
                value={preview.sheet ?? ''}
                disabled={pending || preview.sheets.length < 2}
                onChange={(event) => {
                  reload({ sheet: event.target.value });
                }}
              >
                {preview.sheets.map((sheet) => (
                  <option key={sheet} value={sheet}>
                    {sheet}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        )}
        <div className="flex items-end pb-1.5">
          <Checkbox
            label={t('preview.headerRow')}
            checked={preview.header_row}
            disabled={pending}
            onChange={(event) => {
              reload({ header_row: event.target.checked });
            }}
          />
        </div>
      </div>
      {pending ? (
        <p role="status" className="flex items-center gap-2 text-fg-muted">
          <Spinner />
          {t('preview.loading')}
        </p>
      ) : null}
      {error === null ? null : (
        <div className="flex flex-col gap-2">
          <ErrorAlert error={error} />
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setError(null);
                onLoading(false);
              }}
            >
              {t('preview.dismiss')}
            </Button>
          </div>
        </div>
      )}
      <PreviewTable preview={preview} />
    </div>
  );
}
