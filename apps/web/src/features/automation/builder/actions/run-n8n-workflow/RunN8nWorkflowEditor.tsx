import {
  RUN_N8N_WORKFLOW_MAX_FIELDS,
  type AutomationValue,
  type HttpRequestValue,
  type Id,
  type RunN8nWorkflowConfig,
} from '@cellhive/contracts';
import { Checkbox, Input } from '@cellhive/ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBuilderEnv, useFields } from '../../components/env';
import { Note, PanelField, Segmented } from '../../components/panels/common';
import { ValueInput } from '../../components/values/ValueInput';
import { hasTriggerRecord } from '../../model/draft';
import { HttpTestPanel } from '../http-request/HttpTestPanel';
import { usedStepPaths } from '../http-request/model';
import { ResponseValues, SecretSelect } from '../http-request/parts';

import { n8nPayloadPreview, payloadFields, sendableFields } from './payload';

import type { ActionPanelProps } from '../../components/panels/ActionPanels';

const PATH = {
  url: 'config.url',
  secret: 'config.signing_secret_id',
  fields: 'config.fields',
} as const;

/** Test ids of the controls (E2E). */
const TEST_IDS = {
  n8nSecret: 'n8n-secret',
  n8nUrl: 'n8n-url',
} as const;

/** Fields listed before the list gets a search box. */
const SEARCH_FROM = 10;

function valueOf(value: AutomationValue | undefined): HttpRequestValue {
  if (value === undefined || 'digest' in value) return { literal: '' };
  return value;
}

/** Case- and accent-insensitive match (Vietnamese field names). */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLowerCase();
}

/**
 * `run_n8n_workflow` (BACKLOG T613, CONTRACTS §21, SPEC §13.3): the n8n
 * Webhook node URL, the required `webhook_signing` secret, the fields sent
 * (every field `run_as` reads, or a chosen list), the changes of a
 * `record.updated`, an example of the payload built in the browser, and
 * "Send a test" (T616: the real payload, built by the server with the
 * caller's permissions on a sample record).
 */
export function RunN8nWorkflowEditor({
  action,
  definition,
  scope,
  onChange,
}: ActionPanelProps<'run_n8n_workflow'>) {
  const { t } = useTranslation('automationHttp');
  const env = useBuilderEnv();
  const id = useId();
  const step = action.id as `act_${string}`;
  const config = action.config;
  const set = (patch: Partial<RunN8nWorkflowConfig>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const tableId = hasTriggerRecord(definition.trigger) ? scope.triggerTableId : null;
  // `schedule` and `webhook.received` have no trigger table (`triggerTableOf`).
  const hasRecord = tableId !== null;
  const fields = sendableFields(useFields(hasRecord ? tableId : null));
  const [search, setSearch] = useState('');
  const shownFields =
    search.trim() === ''
      ? fields
      : fields.filter((field) => fold(field.name).includes(fold(search.trim())));
  const chosen = config.fields ?? [];
  const preview = n8nPayloadPreview({
    triggerType: definition.trigger.type,
    automationName: t('n8n.preview.automation'),
    baseName: env.base.name,
    table: tableId === null ? null : { id: tableId, name: env.tableName(tableId) ?? tableId },
    fields: payloadFields(fields, config.fields),
    includeChanges: config.include_changes,
  });

  return (
    <div className="flex flex-col gap-4" data-testid="n8n-editor">
      <Note>{t('n8n.intro')}</Note>
      <PanelField label={t('n8n.url')} step={step} path={PATH.url} hint={t('n8n.urlHint')}>
        {(control) => (
          <ValueInput
            value={'literal' in config.url && config.url.literal === '' ? undefined : config.url}
            onChange={(value) => {
              set({ url: valueOf(value) });
            }}
            field={null}
            allowTemplate
            scope={scope}
            label={t('n8n.url')}
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            testId={TEST_IDS.n8nUrl}
          />
        )}
      </PanelField>
      <SecretSelect
        step={step}
        path={PATH.secret}
        kind="webhook_signing"
        label={t('n8n.secret')}
        hint={t('n8n.secretHint')}
        value={(config.signing_secret_id as string) === '' ? null : config.signing_secret_id}
        testId={TEST_IDS.n8nSecret}
        url={config.url}
        onChange={(secretId) => {
          set({ signing_secret_id: secretId ?? ('' as Id<'sec'>) });
        }}
      />

      {hasRecord ? (
        <PanelField label={t('n8n.fields')} step={step} path={PATH.fields} group>
          {() => (
            <div className="flex flex-col gap-2">
              <Segmented
                label={t('n8n.fields')}
                value={config.fields === null ? 'all' : 'chosen'}
                options={[
                  { value: 'all', label: t('n8n.fieldsAll') },
                  { value: 'chosen', label: t('n8n.fieldsChosen') },
                ]}
                onChange={(mode) => {
                  set({
                    fields:
                      mode === 'all'
                        ? null
                        : fields.slice(0, RUN_N8N_WORKFLOW_MAX_FIELDS).map((field) => field.id),
                  });
                }}
              />
              {config.fields === null ? (
                <p className="text-label font-normal text-fg-muted">{t('n8n.fieldsAllHint')}</p>
              ) : (
                <>
                  <p className="text-label font-normal text-fg-muted" aria-live="polite">
                    {t('n8n.fieldsCount', {
                      count: chosen.length,
                      max: RUN_N8N_WORKFLOW_MAX_FIELDS,
                    })}
                  </p>
                  {fields.length > SEARCH_FROM ? (
                    <Input
                      type="search"
                      value={search}
                      aria-label={t('n8n.fieldsSearch')}
                      placeholder={t('n8n.fieldsSearch')}
                      onChange={(event) => {
                        setSearch(event.target.value);
                      }}
                    />
                  ) : null}
                  <ul
                    className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-line p-2"
                    data-testid="n8n-fields"
                  >
                    {shownFields.map((field) => {
                      const on = chosen.includes(field.id);
                      return (
                        <li key={field.id}>
                          <Checkbox
                            label={field.name}
                            checked={on}
                            disabled={!on && chosen.length >= RUN_N8N_WORKFLOW_MAX_FIELDS}
                            onChange={(event) => {
                              const next = event.target.checked
                                ? [...chosen, field.id]
                                : chosen.filter((item) => item !== field.id);
                              set({ fields: next });
                            }}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </PanelField>
      ) : (
        <Note>{t('n8n.noRecord')}</Note>
      )}

      {definition.trigger.type === 'record.updated' && hasRecord ? (
        <Checkbox
          label={t('n8n.changes')}
          hint={t('n8n.changesHint')}
          checked={config.include_changes}
          data-testid="n8n-changes"
          onChange={(event) => {
            set({ include_changes: event.target.checked });
          }}
        />
      ) : null}

      <section className="flex flex-col gap-1.5" aria-labelledby={`${id}-preview`}>
        <h3 id={`${id}-preview`} className="text-label font-semibold text-fg">
          {t('n8n.preview.title')}
        </h3>
        <p className="text-label font-normal text-fg-muted">
          {t('n8n.preview.hint', { name: env.runAsName ?? '' })}
        </p>
        <pre
          tabIndex={0}
          aria-labelledby={`${id}-preview`}
          className="max-h-72 overflow-auto rounded-md border border-line bg-surface-sunken p-2 font-code text-label break-words whitespace-pre-wrap text-fg"
          data-testid="n8n-preview"
        >
          {JSON.stringify(preview, null, 2)}
        </pre>
      </section>

      <ResponseValues stepId={step} used={usedStepPaths(definition.actions, step)} />
      <HttpTestPanel
        stepId={step}
        step={{ type: 'run_n8n_workflow', config }}
        definition={definition}
        scope={scope}
      />
    </div>
  );
}

export default RunN8nWorkflowEditor;
