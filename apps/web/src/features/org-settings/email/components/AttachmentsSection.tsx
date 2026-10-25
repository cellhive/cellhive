import { Button, FormField, Input, Spinner } from '@cellhive/ui';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { useUpdateEmailSettings } from '../api';

import { SettingsSection } from './SettingsSection';

import type { EmailSettingsDto, UpdateEmailSettingsRequest } from '@cellhive/contracts';

const MIB = 1024 * 1024;

/** Whole MB (MiB) in the field; the API counts bytes. */
function megabytes(bytes: number): string {
  return String(Math.floor(bytes / MIB));
}

/** `null` when `text` is not a whole number in `[min, max]`. */
function parseWhole(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
}

/**
 * "Attachments" (CONTRACTS §23.2, BACKLOG T532): files and total size of
 * one automation email for the organization, at most the instance caps
 * (`EMAIL_MAX_ATTACHMENTS`, `EMAIL_MAX_ATTACHMENT_BYTES`). Saved with its
 * own button (like the system sender switch); "Use the server limits"
 * clears the organization values.
 */
export function AttachmentsSection({
  orgId,
  settings,
}: {
  readonly orgId: string;
  readonly settings: EmailSettingsDto;
}) {
  const { t } = useTranslation('emailSettings');
  const save = useUpdateEmailSettings(orgId);
  const { limits, automation } = settings;
  const capMb = Math.floor(limits.max_attachment_bytes / MIB);
  const [count, setCount] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const countText = count ?? String(automation.max_attachments);
  const sizeText = size ?? megabytes(automation.max_attachment_bytes);
  const countValue = parseWhole(countText, 1, limits.max_attachments);
  const sizeValue = parseWhole(sizeText, 1, capMb);
  const changes: UpdateEmailSettingsRequest = {};
  if (countValue !== null && countValue !== automation.max_attachments) {
    changes.max_attachments = countValue;
  }
  if (sizeValue !== null && sizeValue * MIB !== automation.max_attachment_bytes) {
    changes.max_attachment_bytes = sizeValue * MIB;
  }
  const dirty = Object.keys(changes).length > 0;
  const invalid = countValue === null || sizeValue === null;

  const apply = (body: UpdateEmailSettingsRequest) => {
    setSaved(false);
    save.mutate(body, {
      onSuccess: () => {
        setCount(null);
        setSize(null);
        setSaved(true);
      },
    });
  };

  return (
    <SettingsSection
      data-testid="attachment-limits"
      title={t('attachments.title')}
      description={t('attachments.description')}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField
          label={t('attachments.files')}
          hint={t('attachments.filesHint', { max: limits.max_attachments })}
          error={
            countValue === null
              ? t('attachments.range', { max: limits.max_attachments })
              : undefined
          }
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              data-testid="attachment-max-files"
              value={countText}
              onChange={(event) => {
                setSaved(false);
                setCount(event.target.value);
              }}
            />
          )}
        </FormField>
        <FormField
          label={t('attachments.size')}
          hint={t('attachments.sizeHint', { max: capMb })}
          error={sizeValue === null ? t('attachments.range', { max: capMb }) : undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              data-testid="attachment-max-size"
              value={sizeText}
              onChange={(event) => {
                setSaved(false);
                setSize(event.target.value);
              }}
            />
          )}
        </FormField>
      </div>
      <p className="text-label font-normal text-fg-muted">{t('attachments.note')}</p>
      {save.error !== null && isApiError(save.error) ? <ErrorAlert error={save.error} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="attachment-limits-save"
          disabled={!dirty || invalid || save.isPending}
          onClick={() => {
            apply(changes);
          }}
        >
          {save.isPending ? <Spinner /> : null}
          {t('attachments.save')}
        </Button>
        {automation.attachment_limits_custom ? (
          <Button
            variant="ghost"
            data-testid="attachment-limits-reset"
            disabled={save.isPending}
            onClick={() => {
              apply({ max_attachments: null, max_attachment_bytes: null });
            }}
          >
            {t('attachments.reset')}
          </Button>
        ) : null}
      </div>
      <div role="status" aria-live="polite" data-testid="attachment-limits-saved">
        {saved ? (
          <p className="inline-flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-body text-fg">
            <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-accent" />
            {t('attachments.saved')}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
