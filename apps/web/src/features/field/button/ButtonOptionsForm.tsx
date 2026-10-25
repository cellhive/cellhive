import {
  MAX_BUTTON_CONFIRM_LABEL_LENGTH,
  MAX_BUTTON_CONFIRM_MESSAGE_LENGTH,
  MAX_BUTTON_CONFIRM_TITLE_LENGTH,
  MAX_BUTTON_LABEL_LENGTH,
} from '@cellhive/contracts';
import { Checkbox, cn, FormField, Input } from '@cellhive/ui';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { issueAt, useIssueText } from '../components/shared';
import { OPTION_PALETTE_SIZE, type ButtonDraft, type DraftIssue } from '../draft';

const PALETTE = Array.from({ length: OPTION_PALETTE_SIZE }, (_, index) => index);

const TEXTAREA_CLASSES =
  'min-h-16 w-full rounded-md border border-line-control bg-surface px-3 py-2 text-body text-fg ' +
  'placeholder:text-fg-subtle aria-invalid:border-danger';

export interface ButtonOptionsFormProps {
  readonly value: ButtonDraft;
  /** The field's name: the label when none is typed. */
  readonly name: string;
  readonly issues: readonly DraftIssue[];
  readonly onChange: (value: ButtonDraft) => void;
  /** The automation run by the button (`AutomationCard`), under the options. */
  readonly automation: ReactNode;
}

/**
 * Options of a `button` field (T525, board "S5 · Button field - cấu hình";
 * CONTRACTS §2 `ButtonFieldOptions`): the label on the button, its color
 * (light background of the label palette — Quyết định S5 thiết kế #6) and
 * the confirmation asked before a click is sent. The confirmation is a
 * checkbox, not a switch: it takes effect when the field is saved (F§9.2).
 */
export function ButtonOptionsForm({
  value,
  name,
  issues,
  onChange,
  automation,
}: ButtonOptionsFormProps) {
  const { t } = useTranslation('field');
  const issueText = useIssueText();
  const colorLabel = useId();
  const labelIssue = issueText(issueAt(issues, 'options.label'));
  const titleIssue = issueText(issueAt(issues, 'options.confirm.title'));
  const confirmLabelIssue = issueText(issueAt(issues, 'options.confirm.confirm_label'));
  const messageIssue = issueText(issueAt(issues, 'options.confirm.message'));
  const set = (patch: Partial<ButtonDraft>) => {
    onChange({ ...value, ...patch });
  };
  return (
    <div className="flex flex-col gap-4" data-testid="button-options">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('button.label')} hint={t('button.labelHint')} error={labelIssue}>
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              maxLength={MAX_BUTTON_LABEL_LENGTH}
              placeholder={name.trim()}
              value={value.label}
              data-testid="button-label"
              onChange={(event) => {
                set({ label: event.target.value });
              }}
            />
          )}
        </FormField>
        <div className="flex flex-col gap-1">
          <span id={colorLabel} className="text-label text-fg">
            {t('button.color')}
          </span>
          <div role="radiogroup" aria-labelledby={colorLabel} className="flex flex-wrap gap-1.5">
            {PALETTE.map((color) => {
              const checked = value.color % OPTION_PALETTE_SIZE === color;
              return (
                <label
                  key={color}
                  className={cn(
                    'relative flex size-8 cursor-pointer items-center justify-center rounded-md border-2 max-lg:size-11',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus-ring)]',
                    checked ? 'border-fg' : 'border-transparent',
                  )}
                  style={{ backgroundColor: `var(--option-${String(color)}-bg)` }}
                >
                  <input
                    type="radio"
                    name={colorLabel}
                    className="absolute inset-0 m-0 cursor-pointer appearance-none opacity-0"
                    checked={checked}
                    aria-label={t(`colors.${String(color)}`)}
                    onChange={() => {
                      set({ color });
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none text-label font-medium"
                    style={{ color: `var(--option-${String(color)}-fg)` }}
                  >
                    A
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Checkbox
          label={t('button.confirm')}
          hint={t('button.confirmHint')}
          checked={value.confirm}
          data-testid="button-confirm-toggle"
          onChange={(event) => {
            const on = event.target.checked;
            const label = value.label.trim() === '' ? name.trim() : value.label.trim();
            set({
              confirm: on,
              // Start from the board's wording; the user edits it.
              ...(on && value.confirmTitle === ''
                ? { confirmTitle: t('button.confirmTitleDefault', { label }) }
                : {}),
              ...(on && value.confirmLabel === '' ? { confirmLabel: label } : {}),
            });
          }}
        />
        {value.confirm ? (
          <div className="grid gap-3 sm:grid-cols-2 sm:pl-6">
            <FormField label={t('button.confirmTitle')} error={titleIssue}>
              {(control) => (
                <Input
                  {...control}
                  autoComplete="off"
                  maxLength={MAX_BUTTON_CONFIRM_TITLE_LENGTH}
                  value={value.confirmTitle}
                  data-testid="button-confirm-title"
                  onChange={(event) => {
                    set({ confirmTitle: event.target.value });
                  }}
                />
              )}
            </FormField>
            <FormField label={t('button.confirmLabel')} error={confirmLabelIssue}>
              {(control) => (
                <Input
                  {...control}
                  autoComplete="off"
                  maxLength={MAX_BUTTON_CONFIRM_LABEL_LENGTH}
                  value={value.confirmLabel}
                  data-testid="button-confirm-label"
                  onChange={(event) => {
                    set({ confirmLabel: event.target.value });
                  }}
                />
              )}
            </FormField>
            <FormField
              className="sm:col-span-2"
              label={t('button.confirmMessage')}
              error={messageIssue}
            >
              {(control) => (
                <textarea
                  {...control}
                  rows={2}
                  maxLength={MAX_BUTTON_CONFIRM_MESSAGE_LENGTH}
                  className={TEXTAREA_CLASSES}
                  value={value.confirmMessage}
                  data-testid="button-confirm-message"
                  onChange={(event) => {
                    set({ confirmMessage: event.target.value });
                  }}
                />
              )}
            </FormField>
          </div>
        ) : null}
      </div>

      {automation}
    </div>
  );
}
