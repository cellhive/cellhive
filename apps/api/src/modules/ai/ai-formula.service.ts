import {
  AI_FORMULA_MAX_OUTPUT_TOKENS,
  type AiFormula,
  type AiFormulaRequest,
  type Id,
} from '@cellhive/contracts';
import {
  aiFormulaAnswerSchema,
  AppError,
  formulaDigest,
  formulaMessages,
  formulaRepairProblems,
  loadBaseSchemaRows,
  type AiFormulaAnswer,
  type AiValidation,
  type AppConfig,
  type Db,
  type PreparedComputedDefinition,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { SchemaAccess } from '../../common/schema/schema-access.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { organizationTimeZone, readabilityOf } from '../field/computed-fields.js';
import { editedComputedField, prepareLikeSave } from '../field/computed-preview.service.js';

import { AiAccess } from './ai-access.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/**
 * `POST /tables/:tableId/ai/formula` (CONTRACTS §29.2, BACKLOG T907): a
 * description becomes a formula checked exactly like a save for the caller
 * — the model sees the schema they read (names only), its answer goes
 * through `prepareComputedDefinition` (and the cycle check of the field
 * being edited), errors go back for at most 2 repair rounds. Schema rights
 * on the table like `computed-preview`: `404` / `403` before anything about
 * AI. Nothing is stored.
 */
@Injectable()
export class AiFormulaService {
  constructor(
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(AiAccess) private readonly ai: AiAccess,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async generate(
    principal: Principal,
    tableId: Id<'tbl'>,
    body: AiFormulaRequest,
    meta: RequestMeta,
  ): Promise<AiFormula> {
    const { base, table } = await this.schemaAccess.requireTable(principal, tableId, 'manage');
    const scope = base.org.scope;
    const rows = await loadBaseSchemaRows(this.db, scope, base.base.id);
    const readable = readabilityOf(base.access);
    const editing = editedComputedField(rows, table.id, body.field_id, readable);
    const context = {
      rows,
      tableId: table.id,
      readable,
      timeZone: organizationTimeZone(base, this.config.defaults.timezone),
    };

    const check = async (
      answer: AiFormulaAnswer,
    ): Promise<AiValidation<{ answer: AiFormulaAnswer; prepared: PreparedComputedDefinition }>> => {
      try {
        const prepared = await prepareLikeSave(
          this.db,
          scope,
          {
            type: 'formula',
            options: { expression: answer.formula },
            expressionForm: 'display',
            style: { mode: 'default' },
          },
          context,
          editing,
        );
        return { ok: true, value: { answer, prepared } };
      } catch (error) {
        if (error instanceof AppError) return { ok: false, problems: formulaRepairProblems(error) };
        throw error;
      }
    };

    return this.ai.run(
      principal,
      base.org,
      {
        feature: 'formula',
        recordData: false,
        entityType: 'table',
        entityId: table.id,
        baseId: base.base.id,
        tableId: table.id,
        meta,
      },
      async (call) => {
        const result = await call.llm.completeStructured(
          {
            organizationId: call.organizationId,
            settings: call.settings,
            messages: formulaMessages({
              digest: formulaDigest(rows, table.id, readable, editing?.id ?? null),
              description: body.description,
              current: body.current,
            }),
            output: { kind: 'json', schema: aiFormulaAnswerSchema, name: 'formula' },
            maxOutputTokens: AI_FORMULA_MAX_OUTPUT_TOKENS,
            deadline: call.deadline,
            onUsage: call.onUsage,
          },
          check,
        );
        const { answer, prepared } = result.value;
        call.report({
          attempts: result.attempts,
          outputMode: result.outputMode,
          input: body.description,
          output: answer.formula,
        });
        return {
          formula: answer.formula,
          result_type: prepared.publicType,
          explanation: answer.explanation,
          attempts: result.attempts,
        };
      },
    );
  }
}
