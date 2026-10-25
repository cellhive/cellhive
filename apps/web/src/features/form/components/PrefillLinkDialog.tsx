import { Button, Checkbox, Dialog, Input } from '@cellhive/ui';
import { Copy } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { showToast } from '../../../lib/toast/toast';
import { buildPrefillUrl } from '../model/prefill';

import type { FormQuestion } from '../model/questions';

export interface PrefillLinkDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly questions: readonly FormQuestion[];
  /** The form's address without prefill parameters. */
  readonly url: string;
}

/**
 * "Copy prefill link" (BACKLOG S3 decision 9): a value (and "hide") per
 * question gives `?prefill_<field_id>=…&hide_<field_id>=1`. The same
 * parameters work on the form's share link (T317).
 */
export function PrefillLinkDialog({ open, onOpenChange, questions, url }: PrefillLinkDialogProps) {
  const { t } = useTranslation(['form', 'common']);
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const output = useRef<HTMLInputElement>(null);
  const link = useMemo(
    () =>
      buildPrefillUrl(
        url,
        questions.map((question) => ({
          fieldId: question.field.id,
          value: values[question.field.id] ?? '',
          hide: hidden[question.field.id] === true,
        })),
      ),
    [url, questions, values, hidden],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      showToast({ variant: 'success', message: t('prefill.copied') });
    } catch {
      // No clipboard permission: select the link for a manual copy.
      output.current?.select();
      showToast({ message: t('prefill.selectToCopy') });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('prefill.title')}
      description={t('prefill.description')}
      closeLabel={t('common:actions.close')}
      className="max-w-2xl"
    >
      <ul className="flex max-h-[50dvh] flex-col gap-3 overflow-y-auto">
        {questions.map((question) => {
          const fieldId = question.field.id;
          return (
            <li key={fieldId} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${fieldId}`} className="text-label text-fg">
                {question.label}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id={`${id}-${fieldId}`}
                  value={values[fieldId] ?? ''}
                  maxLength={10_000}
                  onChange={(event) => {
                    setValues((current) => ({ ...current, [fieldId]: event.target.value }));
                  }}
                />
                <Checkbox
                  className="shrink-0"
                  label={t('prefill.hide')}
                  aria-label={t('prefill.hideQuestion', { name: question.label })}
                  checked={hidden[fieldId] === true}
                  onChange={(event) => {
                    setHidden((current) => ({ ...current, [fieldId]: event.target.checked }));
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-link`} className="text-label text-fg">
          {t('prefill.link')}
        </label>
        <div className="flex gap-2">
          <Input
            ref={output}
            id={`${id}-link`}
            readOnly
            value={link}
            className="font-mono text-mono"
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
          <Button
            onClick={() => {
              void copy();
            }}
          >
            <Copy aria-hidden="true" />
            {t('prefill.copy')}
          </Button>
        </div>
        <p className="text-label font-normal text-fg-muted">{t('prefill.hint')}</p>
      </div>
    </Dialog>
  );
}
