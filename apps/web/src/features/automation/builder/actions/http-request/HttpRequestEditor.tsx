import {
  HTTP_REQUEST_MAX_FORM_FIELDS,
  HTTP_REQUEST_MAX_HEADERS,
  HTTP_REQUEST_MAX_QUERY_PARAMS,
  HTTP_REQUEST_METHODS,
  type AutomationValue,
  type HttpRequestBody,
  type HttpRequestConfig,
  type HttpRequestMethod,
  type HttpRequestValue,
} from '@cellhive/contracts';
import { Checkbox, Input, Select } from '@cellhive/ui';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import {
  IssueText,
  Note,
  PanelField,
  Segmented,
  useIssuesAt,
} from '../../components/panels/common';
import { ValueInput } from '../../components/values/ValueInput';

import { HttpTestPanel } from './HttpTestPanel';
import {
  headerNameProblem,
  jsonBodyTemplate,
  jsonBodyValue,
  jsonTemplateProblem,
  switchBodyType,
  usedStepPaths,
  type HeaderNameProblem,
} from './model';
import { PairsEditor, ResponseValues, SecretSelect, type Pair } from './parts';

import type { ActionPanelProps } from '../../components/panels/ActionPanels';
import type { TFunction } from 'i18next';

const PATH = {
  method: 'config.method',
  url: 'config.url',
  query: 'config.query',
  headers: 'config.headers',
  authHeader: 'config.auth.header_name',
  authSecret: 'config.auth.secret_id',
  body: 'config.body',
  bodyValue: 'config.body.value',
  bodyFields: 'config.body.fields',
  signing: 'config.signing_secret_id',
} as const;

/** Test ids of the controls (E2E). */
const TEST_IDS = {
  httpAuthSecret: 'http-auth-secret',
  httpBodyJson: 'http-body-json',
  httpBodyText: 'http-body-text',
  httpForm: 'http-form',
  httpHeaders: 'http-headers',
  httpQuery: 'http-query',
  httpSigningSecret: 'http-signing-secret',
  httpUrl: 'http-url',
} as const;

const DEFAULT_AUTH_HEADER = 'Authorization';

type BodyType = 'none' | HttpRequestBody['type'];

/** A value from the template field: nothing typed is an empty literal (the check names it). */
function valueOf(value: AutomationValue | undefined): HttpRequestValue {
  if (value === undefined || 'digest' in value) return { literal: '' };
  return value;
}

function shown(value: AutomationValue): AutomationValue | undefined {
  return 'literal' in value && value.literal === '' ? undefined : value;
}

/** The warning shown under a header name while typing (`required` waits for the save check). */
export function headerWarning(
  t: TFunction<'automationHttp'>,
  name: string,
  problem: HeaderNameProblem | null,
): string | null {
  switch (problem) {
    case null:
    case 'required':
      return null;
    case 'invalid':
      return t('headers.invalid');
    case 'forbidden':
      return t('headers.forbidden', { name: name.trim() });
    case 'duplicate':
      return t('headers.duplicate', { name: name.trim() });
  }
}

/**
 * `http_request` (BACKLOG T613, CONTRACTS §21; board "S5c · HTTP request
 * action" is not drawn yet — built like the other step panels): method, URL
 * with chips, query parameters, headers (names the outbox owns are flagged
 * while typing), auth with an `http_header` secret, a JSON / form / text
 * body (the JSON is checked while typing), a `webhook_signing` secret,
 * `fail_on_http_error`, the response values later steps may read, and
 * "Send a test".
 */
export function HttpRequestEditor({
  action,
  definition,
  scope,
  onChange,
}: ActionPanelProps<'http_request'>) {
  const { t } = useTranslation('automationHttp');
  const step = action.id as `act_${string}`;
  const config = action.config;
  const id = useId();
  const set = (patch: Partial<HttpRequestConfig>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };
  const headerNames = config.headers.map((header) => header.name);
  const authName = config.auth?.header_name;
  const bodyType: BodyType = config.body === null ? 'none' : config.body.type;
  const get = config.method === 'GET';

  return (
    <div className="flex flex-col gap-4" data-testid="http-request-editor">
      <PanelField label={t('method.label')} step={step} path={PATH.method}>
        {(control) => (
          <Select
            {...control}
            value={config.method}
            className="font-code"
            data-testid="http-method"
            onChange={(event) => {
              set({ method: event.target.value as HttpRequestMethod });
            }}
          >
            {HTTP_REQUEST_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </Select>
        )}
      </PanelField>
      <PanelField label={t('url.label')} step={step} path={PATH.url} hint={t('url.hint')}>
        {(control) => (
          <ValueInput
            value={shown(config.url)}
            onChange={(value) => {
              set({ url: valueOf(value) });
            }}
            field={null}
            allowTemplate
            scope={scope}
            label={t('url.label')}
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            testId={TEST_IDS.httpUrl}
          />
        )}
      </PanelField>

      <PanelField label={t('query.title')} step={step} path={PATH.query} group>
        {() => (
          <PairsEditor
            step={step}
            path={PATH.query}
            pairs={config.query}
            max={HTTP_REQUEST_MAX_QUERY_PARAMS}
            scope={scope}
            testId={TEST_IDS.httpQuery}
            labels={{
              name: t('query.name'),
              value: t('query.value'),
              add: t('query.add'),
              remove: (name) => t('pairs.remove', { name }),
              row: (index) => t('query.row', { number: index + 1 }),
            }}
            onChange={(query: Pair[]) => {
              set({
                query: query.map((pair) => ({ name: pair.name, value: valueOf(pair.value) })),
              });
            }}
          />
        )}
      </PanelField>

      <PanelField label={t('headers.title')} step={step} path={PATH.headers} group>
        {() => (
          <PairsEditor
            step={step}
            path={PATH.headers}
            pairs={config.headers}
            max={HTTP_REQUEST_MAX_HEADERS}
            scope={scope}
            testId={TEST_IDS.httpHeaders}
            labels={{
              name: t('headers.name'),
              value: t('headers.value'),
              add: t('headers.add'),
              remove: (name) => t('pairs.remove', { name }),
              row: (index) => t('headers.row', { number: index + 1 }),
            }}
            nameProblem={(index) => {
              const name = headerNames[index] ?? '';
              const others = [
                ...headerNames.slice(0, index),
                ...(authName === undefined ? [] : [authName]),
              ];
              return headerWarning(t, name, headerNameProblem(name, others));
            }}
            onChange={(headers: Pair[]) => {
              set({
                headers: headers.map((pair) => ({ name: pair.name, value: valueOf(pair.value) })),
              });
            }}
          />
        )}
      </PanelField>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1.5 text-label text-fg">{t('auth.title')}</legend>
        <Segmented
          label={t('auth.title')}
          value={config.auth === null ? 'none' : 'secret'}
          options={[
            { value: 'none', label: t('auth.none') },
            { value: 'secret', label: t('auth.secret') },
          ]}
          onChange={(mode) => {
            set({
              auth:
                mode === 'none'
                  ? null
                  : { header_name: DEFAULT_AUTH_HEADER, secret_id: '' as never },
            });
          }}
        />
        {config.auth === null ? null : (
          <>
            <AuthHeaderName
              step={step}
              value={config.auth.header_name}
              others={headerNames}
              onChange={(header_name) => {
                if (config.auth !== null) set({ auth: { ...config.auth, header_name } });
              }}
            />
            <SecretSelect
              step={step}
              path={PATH.authSecret}
              kind="http_header"
              label={t('auth.secretLabel')}
              hint={t('auth.secretHint')}
              value={(config.auth.secret_id as string) === '' ? null : config.auth.secret_id}
              testId={TEST_IDS.httpAuthSecret}
              url={config.url}
              onChange={(secretId) => {
                if (config.auth !== null) {
                  set({ auth: { ...config.auth, secret_id: secretId ?? ('' as never) } });
                }
              }}
            />
          </>
        )}
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-1.5 text-label text-fg">{t('body.title')}</legend>
        {get ? <Note tone={config.body === null ? 'info' : 'warning'}>{t('body.get')}</Note> : null}
        <Segmented
          label={t('body.title')}
          value={bodyType}
          options={[
            { value: 'none', label: t('body.none') },
            { value: 'json', label: t('body.json'), disabled: get },
            { value: 'form', label: t('body.form'), disabled: get },
            { value: 'text', label: t('body.text'), disabled: get },
          ]}
          onChange={(type) => {
            set({ body: switchBodyType(config.body, type) });
          }}
        />
        <BodyIssue step={step} id={`${id}-body-issue`} />
        {config.body?.type === 'json' ? (
          <JsonBody
            step={step}
            value={config.body.value}
            scope={scope}
            onChange={(value) => {
              set({ body: { type: 'json', value } });
            }}
          />
        ) : null}
        {config.body?.type === 'form' ? (
          <PairsEditor
            step={step}
            path={PATH.bodyFields}
            pairs={config.body.fields}
            max={HTTP_REQUEST_MAX_FORM_FIELDS}
            scope={scope}
            testId={TEST_IDS.httpForm}
            labels={{
              name: t('form.name'),
              value: t('form.value'),
              add: t('form.add'),
              remove: (name) => t('pairs.remove', { name }),
              row: (index) => t('form.row', { number: index + 1 }),
            }}
            onChange={(fields: Pair[]) => {
              set({
                body: {
                  type: 'form',
                  fields: fields.map((pair) => ({ name: pair.name, value: valueOf(pair.value) })),
                },
              });
            }}
          />
        ) : null}
        {config.body?.type === 'text' ? (
          'digest' in config.body.value ? (
            <Note>{t('body.digestKept')}</Note>
          ) : (
            <PanelField label={t('body.textLabel')} step={step} path={PATH.bodyValue}>
              {(control) => (
                <ValueInput
                  value={shown(config.body?.type === 'text' ? config.body.value : { literal: '' })}
                  onChange={(value) => {
                    set({ body: { type: 'text', value: valueOf(value) } });
                  }}
                  field={null}
                  allowTemplate
                  multiline
                  scope={scope}
                  label={t('body.textLabel')}
                  invalid={control['aria-invalid']}
                  describedBy={control['aria-describedby']}
                  testId={TEST_IDS.httpBodyText}
                />
              )}
            </PanelField>
          )
        ) : null}
      </fieldset>

      <SecretSelect
        step={step}
        path={PATH.signing}
        kind="webhook_signing"
        label={t('signing.label')}
        hint={t('signing.hint')}
        noneLabel={t('signing.none')}
        value={config.signing_secret_id}
        testId={TEST_IDS.httpSigningSecret}
        url={config.url}
        onChange={(signing_secret_id) => {
          set({ signing_secret_id });
        }}
      />

      <Checkbox
        label={t('failOnError.label')}
        hint={t('failOnError.hint')}
        checked={config.fail_on_http_error}
        data-testid="http-fail-on-error"
        onChange={(event) => {
          set({ fail_on_http_error: event.target.checked });
        }}
      />

      <ResponseValues stepId={step} used={usedStepPaths(definition.actions, step)} />
      <HttpTestPanel
        stepId={step}
        step={{ type: 'http_request', config }}
        definition={definition}
        scope={scope}
      />
    </div>
  );
}

export default HttpRequestEditor;

function BodyIssue({ step, id }: { readonly step: `act_${string}`; readonly id: string }) {
  // `GET_NO_BODY` and other problems of the body as a whole (not its value or fields).
  const issues = useIssuesAt(step, PATH.body).filter((issue) => issue.path === PATH.body);
  return <IssueText id={id} issues={issues} />;
}

function AuthHeaderName({
  step,
  value,
  others,
  onChange,
}: {
  readonly step: `act_${string}`;
  readonly value: string;
  readonly others: readonly string[];
  readonly onChange: (name: string) => void;
}) {
  const { t } = useTranslation('automationHttp');
  const warning = headerWarning(t, value, headerNameProblem(value, others));
  const id = useId();
  return (
    <PanelField
      label={t('auth.header')}
      step={step}
      path={PATH.authHeader}
      hint={t('auth.headerHint')}
    >
      {(control) => (
        <>
          <Input
            {...control}
            value={value}
            autoComplete="off"
            spellCheck={false}
            className="font-code"
            aria-invalid={warning !== null || control['aria-invalid']}
            aria-describedby={
              [control['aria-describedby'], warning === null ? null : id]
                .filter((item) => item !== null && item !== undefined)
                .join(' ') || undefined
            }
            data-testid="http-auth-header"
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          {warning === null ? null : (
            <p id={id} className="text-label font-normal text-danger">
              {warning}
            </p>
          )}
        </>
      )}
    </PanelField>
  );
}

/**
 * The JSON body: a template with chips, always stored as a template (a
 * literal string would be sent as one JSON string), checked while typing —
 * placeholders render as JSON string content, so text values go in quotes.
 */
function JsonBody({
  step,
  value,
  scope,
  onChange,
}: {
  readonly step: `act_${string}`;
  readonly value: HttpRequestValue;
  readonly scope: ActionPanelProps<'http_request'>['scope'];
  readonly onChange: (value: HttpRequestValue) => void;
}) {
  const { t } = useTranslation('automationHttp');
  const id = useId();
  const display = jsonBodyTemplate(value);
  const problem = 'template' in display ? jsonTemplateProblem(display.template) : null;
  return (
    <PanelField
      label={t('body.jsonLabel')}
      step={step}
      path={PATH.bodyValue}
      hint={t('body.jsonHint')}
    >
      {(control) => (
        <>
          <div className="font-code">
            <ValueInput
              value={'template' in display && display.template === '' ? undefined : display}
              onChange={(next) => {
                onChange(jsonBodyValue(next) as HttpRequestValue);
              }}
              field={null}
              allowTemplate
              multiline
              scope={scope}
              label={t('body.jsonLabel')}
              invalid={problem !== null || control['aria-invalid']}
              describedBy={
                [control['aria-describedby'], problem === null ? null : id]
                  .filter((item) => item !== null && item !== undefined)
                  .join(' ') || undefined
              }
              testId={TEST_IDS.httpBodyJson}
            />
          </div>
          {problem === null ? null : (
            <p
              id={id}
              className="text-label font-normal text-danger"
              data-testid="http-json-problem"
            >
              {problem.position === null
                ? t('body.jsonInvalid')
                : t('body.jsonInvalidAt', { position: problem.position })}
            </p>
          )}
        </>
      )}
    </PanelField>
  );
}
