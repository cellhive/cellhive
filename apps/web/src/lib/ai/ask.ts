import type { AiAsk, FieldDto, WidgetDataDto } from '@cellhive/contracts';
import type { ComponentType } from 'react';

/**
 * "Ask AI" of a table (T914, FRONTEND §20, CONTRACTS §29.4). Three features
 * take part and may not import each other (FRONTEND §1.2): the button in the
 * view toolbar (`features/view/toolbar`, small, in the toolbar's chunk), the
 * panel (`features/ai-ask`, a lazy chunk loaded when it opens) and the
 * dashboard's widget renderer that draws an answer (`features/dashboard`,
 * another lazy chunk, with ECharts lazier still). The route composes them;
 * they talk through these types only.
 */

/** An answer with numbers. */
export type AiAnswer = Extract<AiAsk, { status: 'ok' }>;

/** What the button gets from the grid: the table and the fields the user reads. */
export interface AskAiEntryProps {
  readonly table: { readonly id: string; readonly name: string };
  /** Fields the user reads, in server order (suggestions, number formats). */
  readonly fields: readonly FieldDto[];
  /** Organization of the base: whether AI is available there (`useAiAvailability`). */
  readonly orgId: string;
}

/** The panel, opened by the button; `onClose` gives the focus back to it. */
export interface AskAiPanelProps extends AskAiEntryProps {
  readonly onClose: () => void;
}

/** The dashboard widget renderer for one answer (KPI, chart, pivot table). */
export interface AskAnswerWidgetProps {
  readonly widget: AiAnswer['widget'];
  readonly data: WidgetDataDto;
  readonly fields: readonly FieldDto[];
}

export type AskAiPanelComponent = ComponentType<AskAiPanelProps>;
export type AskAnswerWidgetComponent = ComponentType<AskAnswerWidgetProps>;
