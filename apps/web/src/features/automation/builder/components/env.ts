import { createContext, useContext, type ComponentType } from 'react';

import type { AutomationConditionEditorProps } from '../../../../lib/automation/condition-editor';
import type { WebhookKit } from '../../../../lib/automation/webhook-kit';
import type { BuilderIssue } from '../model/issues';
import type { ScopeNames } from '../model/scope';
import type { BaseDetail, FieldDto, TableDto, ViewDto } from '@cellhive/contracts';

/**
 * What every part of the builder reads (T521): the base and its schema as
 * the caller sees it, the issues of the last check, whether it edits, and
 * the condition editor the route gives (FRONTEND §1.2).
 */
export interface BuilderEnv extends ScopeNames {
  readonly base: BaseDetail;
  readonly orgId: string;
  /** IANA zone a `schedule` without its own uses (the organization's). */
  readonly orgTimeZone: string;
  readonly meId: string | null;
  /** (T525) The automation being edited, `null` while new (a button may run only one). */
  readonly automationId?: string | null;
  /**
   * (T525) Who the automation runs as once saved: the caller when the
   * definition changed (ADR-25 §2), else the saved `run_as`.
   */
  readonly runAsName?: string | null;
  readonly tables: readonly TableDto[];
  readonly tableName: (tableId: string) => string | undefined;
  /** (T612) Name of an incoming webhook of the base (`undefined`: unknown or not loaded). */
  readonly webhookName?: ((hookId: string) => string | undefined) | undefined;
  /** Shared form views of the tables the caller manages (`form.submitted`). */
  readonly forms: readonly ViewDto[];
  readonly issues: readonly BuilderIssue[];
  /** Phones (< 768 px): look and turn on/off only (FRONTEND §13.2). */
  readonly readOnly: boolean;
  /** (T522) No instance SMTP and no sender identity in the base: `send_email` is locked. */
  readonly emailUnavailable: boolean;
  /** (T522) The organization's email settings page, for its owners/admins (`null` otherwise). */
  readonly emailSettingsPath: string | null;
  readonly ConditionEditor: ComponentType<AutomationConditionEditorProps>;
  /** (T612) "New webhook", secrets shown once, the URL field — from `features/integrations`. */
  readonly webhookKit: WebhookKit;
  /** Remembers the state of a condition editor (`check.ts` `conditionSlot`). */
  readonly setConditionState: (
    slot: string,
    state: { readonly valid: boolean; readonly incomplete: number } | null,
  ) => void;
  /** Bumped when the draft is reset: editors holding their own state start over. */
  readonly resetKey: number;
}

export const BuilderEnvContext = createContext<BuilderEnv | null>(null);

export function useBuilderEnv(): BuilderEnv {
  const env = useContext(BuilderEnvContext);
  if (env === null) throw new Error('useBuilderEnv outside the automation builder');
  return env;
}

/** Fields of a table, `[]` while loading. */
export function useFields(tableId: string | null): readonly FieldDto[] {
  const env = useBuilderEnv();
  return tableId === null ? [] : (env.fieldsOf(tableId) ?? []);
}
