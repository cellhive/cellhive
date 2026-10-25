import { foldText } from '@cellhive/filter-dsl';
import { cn, Input } from '@cellhive/ui';
import { Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  displayedSender,
  SENDER_RADIO_MAX,
  senderKeyOf,
  type SenderMode,
  type SenderOption,
} from './model';

export interface SenderPickerProps {
  readonly options: readonly SenderOption[];
  /** `identity_id` of the step (`null` = system sender). */
  readonly value: string | null;
  readonly onChange: (identityId: SenderOption['identityId']) => void;
  readonly smtpFrom: string | null;
  readonly orgLocale: string | null | undefined;
  /** The `From` the server rendered for the current sender (preview), when known. */
  readonly previewFrom: string | null;
  readonly previewReplyTo: string | null;
  readonly describedBy?: string | undefined;
}

const MODE_TONE: Record<SenderMode, string> = {
  system: 'bg-surface-sunken text-fg-muted',
  send_as: 'bg-option-5 text-on-option-5',
  on_behalf: 'bg-option-3 text-on-option-3',
};

/**
 * "Sender" (Quyết định S5 thiết kế #1; ADR-33): a radio list up to five
 * senders, with a search box above when there are more; each shows its
 * mode (system, sends directly, on behalf) and the `From` recipients will
 * see — the line of the chosen one stays visible, from the preview once
 * the server rendered it.
 */
export function SenderPicker({
  options,
  value,
  onChange,
  smtpFrom,
  orgLocale,
  previewFrom,
  previewReplyTo,
  describedBy,
}: SenderPickerProps) {
  const { t } = useTranslation('automationEmail');
  const name = useId();
  const [query, setQuery] = useState('');
  const current = senderKeyOf(value);
  const many = options.length > SENDER_RADIO_MAX;
  const shown = useMemo(() => {
    const needle = foldText(query.trim());
    if (!many || needle === '') return options;
    return options.filter(
      (option) =>
        option.key === current || foldText(`${option.name} ${option.email ?? ''}`).includes(needle),
    );
  }, [options, query, many, current]);

  const line = (option: SenderOption, selected: boolean) => {
    const display = displayedSender(option, smtpFrom, orgLocale, t('sender.systemAddress'));
    const from = selected && previewFrom !== null ? previewFrom : display.from;
    const replyTo = selected && previewFrom !== null ? previewReplyTo : display.replyTo;
    return replyTo === null
      ? t('sender.shows', { from })
      : t('sender.showsReply', { from, replyTo });
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={describedBy}>
      <legend className="mb-1.5 text-label text-fg">{t('sender.label')}</legend>
      {many ? (
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            type="search"
            value={query}
            className="pl-8"
            aria-label={t('sender.search')}
            placeholder={t('sender.search')}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
      ) : null}
      <div
        className={cn(
          'flex flex-col overflow-hidden rounded-md border border-line',
          many && 'max-h-72 overflow-y-auto',
        )}
        data-testid="sender-options"
      >
        {shown.length === 0 ? (
          <p className="px-3 py-2 text-label font-normal text-fg-muted">{t('sender.noMatch')}</p>
        ) : null}
        {shown.map((option) => {
          const selected = option.key === current;
          return (
            <label
              key={option.key}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent',
                selected && 'bg-accent-soft',
              )}
              data-testid={`sender-${option.key}`}
            >
              <input
                type="radio"
                name={name}
                className="mt-1 size-4 shrink-0 accent-accent"
                checked={selected}
                onChange={() => {
                  onChange(option.identityId);
                }}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-body font-medium">{option.name}</span>
                  {option.email === null ? null : (
                    <span className="text-label font-normal text-fg-muted">{option.email}</span>
                  )}
                  <span
                    className={cn(
                      'inline-flex h-5 items-center rounded-sm px-1.5 text-label',
                      MODE_TONE[option.mode],
                    )}
                  >
                    {t(`sender.mode.${option.mode}`)}
                  </span>
                </span>
                <span
                  className="text-label font-normal break-words text-fg-muted"
                  data-testid={selected ? 'sender-shows' : undefined}
                >
                  {line(option, selected)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
