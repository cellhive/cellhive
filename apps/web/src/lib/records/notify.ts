import { FIELD_TYPE_REGISTRY, type FieldConfig, type LocaleContext } from '@cellhive/field-types';

import { translateDetail, type Translator } from '../errors/translate';
import { showErrorToast, showToast } from '../toast/toast';

import type { EditNotifier } from './edit-controller';
import type { CellErrorDetail } from './write-errors';
import type { FieldDto } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

/**
 * The toasts of the FRONTEND §4.1 error table, shared by every screen that
 * edits records (grid, record panel): the conflict toast (warning icon)
 * with "Keep their value" / "Write my value", refusals, the record that went away and failures with
 * a retry. Texts live in the `grid` namespace (T203).
 */

/** A field as the edit flow knows it: the DTO and its parsed options (`null`: unknown type). */
export interface NotifyField {
  readonly field: FieldDto;
  readonly config: FieldConfig | null;
}

/** Translated reason of a refused cell (`errors:detail.<code>`, else `errors:codes.<code>`). */
export function cellErrorMessage(translator: Translator, detail: CellErrorDetail): string {
  if (translator.exists(`errors:detail.${detail.code}`)) {
    return translateDetail(translator, {
      code: detail.code,
      ...(detail.params === undefined ? {} : { params: { ...detail.params } }),
      ...(detail.message === undefined ? {} : { message: detail.message }),
    });
  }
  if (translator.exists(`errors:codes.${detail.code}`)) {
    return translator.t(`errors:codes.${detail.code}`);
  }
  return detail.message ?? translator.t('errors:client.UNEXPECTED_RESPONSE');
}

/** A cell value as text for toasts, like `cell_format=text`; empty reads "(empty)". */
export function cellText(
  field: Pick<NotifyField, 'config'> | undefined,
  value: unknown,
  locale: LocaleContext,
  i18n: Pick<I18n, 't'>,
): string {
  const empty = i18n.t('grid:edit.emptyValue');
  if (value === null || value === undefined) return empty;
  const config = field?.config;
  if (config === null || config === undefined) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  const text = (
    FIELD_TYPE_REGISTRY[config.type] as {
      formatText: (value: unknown, options: unknown, ctx: LocaleContext) => string;
    }
  ).formatText(value, config.options, locale);
  return text === '' ? empty : text;
}

/** What the notifier reads at the time a toast is shown (texts and fields change). */
export interface NotifyContext {
  readonly i18n: Pick<I18n, 't'>;
  readonly fields: readonly NotifyField[];
  readonly locale: LocaleContext;
}

/** The FRONTEND §4.1 toasts for a `RecordEditController`. */
export function createEditNotifier(context: () => NotifyContext): EditNotifier {
  return {
    conflict: (notice) => {
      const { i18n, fields, locale } = context();
      const t = i18n.t;
      const field = fields.find((column) => column.field.id === notice.fieldId);
      showToast({
        variant: 'warning',
        title: t('grid:edit.conflict.title'),
        message: t('grid:edit.conflict.message', {
          name: notice.updatedBy?.name ?? t('grid:edit.conflict.someone'),
          field: field?.field.name ?? '',
        }),
        details: [
          {
            label: t('grid:edit.conflict.theirs'),
            value: cellText(field, notice.theirs, locale, i18n),
          },
          {
            label: t('grid:edit.conflict.mine'),
            value: cellText(field, notice.mine, locale, i18n),
          },
        ],
        actions: [
          { label: t('grid:edit.conflict.keepTheirs'), onClick: () => undefined },
          { label: t('grid:edit.conflict.writeMine'), onClick: notice.writeMine, primary: true },
        ],
      });
    },
    denied: (error) => {
      showErrorToast(error);
    },
    notFound: () => {
      showToast({ message: context().i18n.t('grid:edit.recordGone') });
    },
    failed: (error, retry) => {
      showErrorToast(
        error,
        retry === null
          ? {}
          : { actions: [{ label: context().i18n.t('grid:edit.retry'), onClick: retry }] },
      );
    },
  };
}
