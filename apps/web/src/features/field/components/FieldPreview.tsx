import {
  getFieldType,
  isDateOnlyFormat,
  type FieldConfig,
  type LocaleContext,
} from '@cellhive/field-types';
import { cn } from '@cellhive/ui';
import { Check, Paperclip } from 'lucide-react';
import { createElement, useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ButtonPill } from '../../../grid/display/ButtonValue';
import { typeIconOf } from '../../../lib/schema/field-icons';

import { autoNumberPreview } from './options/AutoNumberRulesBuilder';
import { optionChipClass } from './options/SelectOptionsEditor';

import type { FieldDraftType, DraftFieldType } from '../draft';

export interface FieldPreviewProps {
  /** Parsed options of the draft, `null` while the form is invalid. */
  readonly config: FieldConfig | null;
  readonly type: DraftFieldType;
  readonly name: string;
  readonly locale: LocaleContext;
  /** Name of the signed-in user (user fields show them). */
  readonly userName: string;
  readonly now: Date;
  /** (T525) Label and color of a button field. */
  readonly button?: { readonly label: string; readonly color: number } | undefined;
}

/** Sample cells formatted like the grid and `cell_format=text` would show them. */
function samples(config: FieldConfig, ctx: LocaleContext, userName: string, now: Date): string[] {
  const format = (value: unknown) =>
    getFieldType(config.type)?.formatText(value, config.options, ctx) ?? '';
  switch (config.type) {
    case 'number': {
      const style = config.options.style;
      if (style.type === 'rating') return [format(Math.min(3, style.max)), format(style.max)];
      if (style.type === 'progress' || (style.type === 'plain' && style.percentage)) {
        return [format(0.25), format(0.8)];
      }
      return [format(1234.5), format(-42)];
    }
    case 'datetime':
    case 'created_at':
    case 'updated_at': {
      const dateOnly = isDateOnlyFormat(config.options.style.format);
      return [format(dateOnly ? now.toISOString().slice(0, 10) : now.toISOString())];
    }
    case 'user':
    case 'created_by':
    case 'updated_by':
      return [userName];
    case 'auto_number':
      return autoNumberPreview(config.options.style.rules, ctx.timeZone, now) ?? [];
    default:
      return [];
  }
}

/** The icon of a field type (a component, so the icon is not created during render). */
function TypeIcon({ type }: { type: FieldDraftType }) {
  return createElement(typeIconOf(type), {
    'aria-hidden': true,
    className: 'size-4 shrink-0 text-fg-muted',
  });
}

/**
 * Preview panel of the field dialog (design "Đổi kiểu field"): the column
 * header and a few cells as they will look with the current settings.
 */
export function FieldPreview({
  config,
  type,
  name,
  locale,
  userName,
  now,
  button,
}: FieldPreviewProps) {
  const { t } = useTranslation('field');
  const headingId = useId();
  let body: ReactNode;
  if (type === 'button') {
    // Button (T525, board "S5 · Button field - cấu hình"): ready, and when it cannot run.
    const label = button?.label.trim() ?? '';
    const shown = label === '' ? name.trim() || t('preview.untitled') : label;
    const color = button?.color ?? 0;
    body = (
      <div className="flex flex-col items-start gap-2">
        <span className="text-label font-normal text-fg-muted">{t('button.preview.ready')}</span>
        <ButtonPill label={shown} color={color} view={{ state: 'ready' }} />
        <span className="text-label font-normal text-fg-muted">{t('button.preview.disabled')}</span>
        <ButtonPill label={shown} color={color} view={{ state: 'disabled', reason: 'condition' }} />
        <ul className="list-disc pl-4 text-label font-normal text-fg-muted">
          <li>{t('button.preview.noFilter')}</li>
          <li>{t('button.preview.noForm')}</li>
          <li>{t('button.preview.export')}</li>
          <li>{t('button.preview.limit')}</li>
        </ul>
      </div>
    );
  } else if (type === 'link') {
    // Link (T413): the cell shows the linked records' titles as chips.
    body = (
      <ul className="flex flex-wrap gap-1">
        {[t('preview.link.first'), t('preview.link.second')].map((sample) => (
          <li
            key={sample}
            className="rounded-sm border border-line bg-surface-sunken px-2 py-0.5 text-label font-normal"
          >
            {sample}
          </li>
        ))}
      </ul>
    );
  } else if (config === null) {
    body = <p className="text-label font-normal text-fg-muted">{t('preview.invalid')}</p>;
  } else if (config.type === 'select') {
    const options = config.options.options.slice(0, 6);
    body =
      options.length === 0 ? (
        <p className="text-label font-normal text-fg-muted">{t('preview.noOptions')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {options.map((option, index) => (
            <li
              key={option.id}
              className={cn(
                'rounded-sm px-2 py-0.5 text-label',
                optionChipClass(option.color ?? index),
              )}
            >
              {option.name}
            </li>
          ))}
        </ul>
      );
  } else if (config.type === 'attachment') {
    body = (
      <ul className="flex flex-wrap gap-1">
        {[t('preview.attachment.first'), t('preview.attachment.second')].map((name) => (
          <li
            key={name}
            className="inline-flex items-center gap-1 rounded-sm bg-surface-sunken px-1.5 text-label leading-5 font-normal"
          >
            <Paperclip aria-hidden="true" className="size-3 text-fg-muted" />
            {name}
          </li>
        ))}
      </ul>
    );
  } else if (config.type === 'checkbox') {
    body = (
      <span className="flex size-4 items-center justify-center rounded-sm bg-accent text-on-accent">
        <Check aria-hidden="true" className="size-3" />
        <span className="sr-only">{t('preview.checked')}</span>
      </span>
    );
  } else if (config.type === 'text') {
    const style = config.options.style.type;
    body = (
      <p
        className={cn(
          'text-body',
          style === 'url' || style === 'email' ? 'text-accent underline' : '',
          style === 'barcode' && 'font-mono text-mono',
        )}
      >
        {t(`preview.text.${style}`)}
      </p>
    );
  } else {
    const values = samples(config, locale, userName, now);
    body = (
      <ul className="flex flex-col gap-1">
        {values.map((value, index) => (
          <li
            // Samples can repeat (e.g. equal ratings); position is their identity.
            key={`${String(index)}:${value}`}
            className={cn(
              'text-body text-fg',
              (config.type === 'number' || config.type === 'auto_number') && 'tabular-nums',
              config.type === 'auto_number' && 'font-mono text-mono',
            )}
          >
            {value}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken p-3"
    >
      <h3 id={headingId} className="text-label text-fg-muted">
        {t('preview.title')}
      </h3>
      <div className="flex flex-col overflow-hidden rounded-md border border-line bg-surface">
        <p className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-label text-fg">
          <TypeIcon type={type} />
          <span className="truncate">{name.trim() === '' ? t('preview.untitled') : name}</span>
        </p>
        <div className="px-3 py-2">{body}</div>
      </div>
    </section>
  );
}
