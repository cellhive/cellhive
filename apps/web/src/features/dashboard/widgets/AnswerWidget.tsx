import { useTranslation } from 'react-i18next';

import { TEST_IDS } from '../test-ids';

import { WidgetBoundary } from './WidgetBoundary';
import { WidgetMessage } from './WidgetMessage';
import { useWidgetShape, WidgetResult, type WidgetViewConfig } from './WidgetResult';

import type { AskAnswerWidgetProps } from '../../../lib/ai/ask';

/**
 * (T914) An answer of "Ask AI" (CONTRACTS §29.4) drawn by the dashboard's
 * widget renderer: the temporary widget the server planned (its config has
 * ids, as a dashboard would store it) with the numbers it computed — a KPI,
 * a chart with "View as table" (ECharts, lazy) or a pivot table, formatted
 * by the table's fields. Nothing to filter, no menu: the answer is not a
 * dashboard widget. A chunk of its own, loaded by the panel's first answer.
 */
export default function AnswerWidget({ widget, data, fields }: AskAnswerWidgetProps) {
  const { t } = useTranslation('dashboard');
  const config = widget.config as WidgetViewConfig;
  const shape = useWidgetShape(config, fields);
  const title = widget.title.trim() === '' ? t(`type.${widget.type}`) : widget.title;
  return (
    <WidgetBoundary
      fallback={(reset) => (
        <WidgetMessage
          kind="error"
          title={t('state.renderFailed')}
          onRetry={reset}
          testId={TEST_IDS.widgetState}
        />
      )}
    >
      {data.status === 'ok' ? (
        <WidgetResult
          {...shape}
          type={widget.type}
          config={config}
          title={title}
          data={data}
          fields={fields}
        />
      ) : data.status === 'empty' ? (
        <WidgetMessage
          kind="empty"
          title={t('state.empty.title')}
          detail={
            config.filter === null || config.filter === undefined
              ? t('state.empty.detail')
              : t('state.empty.filtered')
          }
          testId={TEST_IDS.widgetState}
        />
      ) : (
        // The server answers `unanswerable` instead (CONTRACTS §29.4): never which field.
        <WidgetMessage
          kind="no_permission"
          title={t('state.noPermission')}
          testId={TEST_IDS.widgetState}
        />
      )}
    </WidgetBoundary>
  );
}
