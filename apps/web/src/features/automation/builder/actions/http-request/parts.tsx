import { Button, Input, Select, Tooltip } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { isOrgAdmin } from '../../../../../lib/permissions/org';
import { meQuery } from '../../../../../lib/session/session';
import { useBuilderEnv } from '../../components/env';
import { IssueText, Note, PanelField, useIssuesAt } from '../../components/panels/common';
import { ValueInput } from '../../components/values/ValueInput';

import { baseSecretsQuery } from './api';
import { HTTP_BASE_PATHS, isResponsePath } from './model';
import { pickResponsePath, unpickResponsePath, usePickedResponsePaths } from './response-paths';
import { SecretHostNote, useSecretHostVerdict } from './SecretHostNote';

import type { ValueScope } from '../../model/scope';
import type { AutomationValue, HttpRequestValue, Id, SecretKind } from '@cellhive/contracts';

/** An example response path (not translated). */
const PATH_EXAMPLE = 'body.id';

/**
 * The organization's integrations page (allowlist, HTTP secrets) for its
 * owners/admins, `null` for anyone else — they are told to ask one.
 */
export function useIntegrationsPath(): string | null {
  const env = useBuilderEnv();
  const me = useQuery(meQuery());
  const org = me.data?.orgs.find((item) => item.id === env.orgId);
  if (org === undefined || !isOrgAdmin(org.role)) return null;
  return `/o/${encodeURIComponent(org.slug)}/settings/integrations`;
}

/**
 * A secret of the organization usable in this base, chosen by name
 * (`GET /bases/:id/secrets?kind=` — never a value). A saved secret no longer
 * in scope is named so; none at all explains where secrets come from.
 */
export function SecretSelect({
  step,
  path,
  kind,
  label,
  hint,
  value,
  noneLabel,
  testId,
  url,
  onChange,
}: {
  readonly step: `act_${string}`;
  readonly path: string;
  readonly kind: Extract<SecretKind, 'http_header' | 'webhook_signing'>;
  /** (T717) The step URL: the chosen secret's allowed hosts are checked against it. */
  readonly url?: HttpRequestValue;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly value: string | null;
  /** The empty choice (`null`), e.g. "Do not sign"; without it the empty choice is "Choose…". */
  readonly noneLabel?: string;
  readonly testId: string;
  readonly onChange: (secretId: Id<'sec'> | null) => void;
}) {
  const { t } = useTranslation('automationHttp');
  const env = useBuilderEnv();
  const integrations = useIntegrationsPath();
  const secrets = useQuery(baseSecretsQuery(env.base.id, kind));
  const items = secrets.data?.items ?? [];
  const current = value ?? '';
  const known = current === '' || items.some((item) => item.id === current);
  const hostsId = useId();
  const verdict = useSecretHostVerdict(current === '' ? null : current, url, integrations);
  return (
    <>
      <PanelField label={label} step={step} path={path} hint={hint}>
        {(control) => (
          <Select
            {...control}
            aria-describedby={
              [control['aria-describedby'], verdict === null ? null : hostsId]
                .filter((item) => item !== null && item !== undefined)
                .join(' ') || undefined
            }
            value={current}
            disabled={secrets.isPending}
            data-testid={testId}
            onChange={(event) => {
              const next = event.target.value;
              onChange(next === '' ? null : (next as Id<'sec'>));
            }}
          >
            <option value="">{noneLabel ?? t('secret.choose')}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            {known || secrets.isPending ? null : (
              <option value={current}>{t('secret.unknown')}</option>
            )}
          </Select>
        )}
      </PanelField>
      {verdict === null ? null : (
        <SecretHostNote
          id={hostsId}
          verdict={verdict}
          url={url}
          integrations={integrations}
          testId={`${testId}-hosts`}
        />
      )}
      {secrets.isSuccess && items.length === 0 ? (
        <Note tone="warning" title={t(`secret.none.${kind}`)} testId={`${testId}-none`}>
          {integrations === null ? (
            t('secret.askAdmin')
          ) : (
            <>
              {t('secret.addThere')}{' '}
              <Link to={integrations} className="text-accent underline">
                {t('secret.openIntegrations')}
              </Link>
            </>
          )}
        </Note>
      ) : null}
    </>
  );
}

export interface Pair {
  readonly name: string;
  readonly value: AutomationValue;
}

/** A value of a pair as the template field shows it (an empty literal is nothing). */
function shown(value: AutomationValue): AutomationValue | undefined {
  return 'literal' in value && value.literal === '' ? undefined : value;
}

/**
 * Name/value rows (query parameters, headers, form fields): each row a
 * name, a value with chips, and a remove button; "Add" below up to `max`.
 * `nameProblem` warns about a name while typing (headers the outbox owns).
 */
export function PairsEditor({
  step,
  path,
  pairs,
  max,
  scope,
  labels,
  testId,
  nameProblem,
  onChange,
}: {
  readonly step: `act_${string}`;
  readonly path: string;
  readonly pairs: readonly Pair[];
  readonly max: number;
  readonly scope: ValueScope;
  readonly labels: {
    readonly name: string;
    readonly value: string;
    readonly add: string;
    readonly remove: (name: string) => string;
    readonly row: (index: number) => string;
  };
  readonly testId: string;
  readonly nameProblem?: (index: number) => string | null;
  readonly onChange: (pairs: Pair[]) => void;
}) {
  const { t } = useTranslation('automationHttp');
  // Stable row keys (rows have no id): kept in step with adds and removes made here,
  // renumbered when the rows change elsewhere (a reset of the draft).
  const [rowKeys, setRowKeys] = useState(() => pairs.map((_, index) => index));
  const [nextKey, setNextKey] = useState(pairs.length);
  if (rowKeys.length !== pairs.length) {
    setRowKeys(pairs.map((_, index) => nextKey + index));
    setNextKey(nextKey + pairs.length);
  }
  const set = (index: number, patch: Partial<Pair>) => {
    onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...patch } : pair)));
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {pairs.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {pairs.map((pair, index) => (
            <PairRow
              key={rowKeys[index] ?? -1 - index}
              step={step}
              path={`${path}[${String(index)}]`}
              pair={pair}
              scope={scope}
              label={labels.row(index)}
              nameLabel={labels.name}
              valueLabel={labels.value}
              removeLabel={labels.remove(pair.name.trim() === '' ? labels.row(index) : pair.name)}
              warning={nameProblem?.(index) ?? null}
              testId={`${testId}-row`}
              onName={(name) => {
                set(index, { name });
              }}
              onValue={(value) => {
                set(index, { value });
              }}
              onRemove={() => {
                setRowKeys(rowKeys.filter((_, at) => at !== index));
                onChange(pairs.filter((_, at) => at !== index));
              }}
            />
          ))}
        </ul>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="self-start max-lg:h-control"
        disabled={pairs.length >= max}
        data-testid={`${testId}-add`}
        onClick={() => {
          setRowKeys([...rowKeys, nextKey]);
          setNextKey(nextKey + 1);
          onChange([...pairs, { name: '', value: { literal: '' } }]);
        }}
      >
        <Plus aria-hidden="true" />
        {labels.add}
        <span className="font-normal text-fg-muted">
          {t('pairs.count', { count: pairs.length, max })}
        </span>
      </Button>
    </div>
  );
}

function PairRow({
  step,
  path,
  pair,
  scope,
  label,
  nameLabel,
  valueLabel,
  removeLabel,
  warning,
  testId,
  onName,
  onValue,
  onRemove,
}: {
  readonly step: `act_${string}`;
  readonly path: string;
  readonly pair: Pair;
  readonly scope: ValueScope;
  readonly label: string;
  readonly nameLabel: string;
  readonly valueLabel: string;
  readonly removeLabel: string;
  readonly warning: string | null;
  readonly testId: string;
  readonly onName: (name: string) => void;
  readonly onValue: (value: AutomationValue) => void;
  readonly onRemove: () => void;
}) {
  const id = useId();
  const nameIssues = useIssuesAt(step, `${path}.name`);
  const valueIssues = useIssuesAt(step, `${path}.value`);
  const warningId = `${id}-warning`;
  const nameIssueId = `${id}-name-issues`;
  const valueIssueId = `${id}-value-issues`;
  const nameDescribedBy =
    [warning === null ? null : warningId, nameIssues.length > 0 ? nameIssueId : null]
      .filter((item) => item !== null)
      .join(' ') || undefined;
  return (
    <li
      className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-sunken/40 p-2"
      aria-label={label}
      data-testid={testId}
    >
      <div className="flex items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-name`} className="sr-only">
            {nameLabel}
          </label>
          <Input
            id={`${id}-name`}
            value={pair.name}
            placeholder={nameLabel}
            autoComplete="off"
            spellCheck={false}
            className="font-code"
            aria-invalid={warning !== null || nameIssues.length > 0 || undefined}
            aria-describedby={nameDescribedBy}
            data-testid={`${testId}-name`}
            onChange={(event) => {
              onName(event.target.value);
            }}
          />
          {warning === null ? null : (
            <p
              id={warningId}
              className="text-label font-normal text-danger"
              data-testid={`${testId}-warning`}
            >
              {warning}
            </p>
          )}
          {warning === null ? <IssueText id={nameIssueId} issues={nameIssues} /> : null}
        </div>
        <Tooltip content={removeLabel}>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 max-lg:size-control"
            aria-label={removeLabel}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      <ValueInput
        value={shown(pair.value)}
        onChange={(value) => {
          onValue(value ?? { literal: '' });
        }}
        field={null}
        allowTemplate
        scope={scope}
        label={valueLabel}
        invalid={valueIssues.length > 0 || undefined}
        describedBy={valueIssues.length > 0 ? valueIssueId : undefined}
        testId={`${testId}-value`}
      />
      <IssueText id={valueIssueId} issues={valueIssues} />
    </li>
  );
}

/**
 * "Values for later steps" (BACKLOG T613): what later steps may read from
 * this step's response through "+" — `status`, `body`, and the paths picked
 * from a test response or typed here (`body.id`, `body.items[0].sku`).
 */
export function ResponseValues({
  stepId,
  used,
}: {
  readonly stepId: string;
  /** Paths later steps already use (kept in the definition, listed even after a reload). */
  readonly used: readonly string[];
}) {
  const { t } = useTranslation('automationHttp');
  const picked = usePickedResponsePaths(stepId);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(false);
  const id = useId();
  const fixed = [...new Set([...HTTP_BASE_PATHS, ...used])];
  const extra = picked.filter((path) => !fixed.includes(path));
  const add = () => {
    const path = draft.trim();
    if (!isResponsePath(path)) {
      setError(true);
      return;
    }
    pickResponsePath(stepId, path);
    setDraft('');
    setError(false);
  };
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-label font-semibold text-fg">
        {t('paths.title')}
      </h3>
      <p className="text-label font-normal text-fg-muted">{t('paths.hint')}</p>
      <ul className="flex flex-wrap gap-1.5" data-testid="http-paths">
        {fixed.map((path) => (
          <li
            key={path}
            className="inline-flex h-6 items-center rounded-full border border-option-3 bg-option-3 px-2 font-code text-label text-on-option-3"
          >
            {path}
          </li>
        ))}
        {extra.map((path) => (
          <li
            key={path}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-option-3 bg-option-3 pr-0.5 pl-2 font-code text-label text-on-option-3"
            data-testid="http-path-picked"
          >
            {path}
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded-full hover:bg-surface/60"
              aria-label={t('paths.remove', { path })}
              onClick={() => {
                unpickResponsePath(stepId, path);
              }}
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-start gap-1"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-input`} className="sr-only">
            {t('paths.inputLabel')}
          </label>
          <Input
            id={`${id}-input`}
            value={draft}
            placeholder={PATH_EXAMPLE}
            autoComplete="off"
            spellCheck={false}
            className="font-code"
            aria-invalid={error || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            data-testid="http-path-input"
            onChange={(event) => {
              setDraft(event.target.value);
              setError(false);
            }}
          />
          {error ? (
            <p id={`${id}-error`} className="text-label font-normal text-danger">
              {t('paths.invalid')}
            </p>
          ) : null}
        </div>
        <Button
          type="submit"
          variant="secondary"
          className="max-lg:h-control"
          data-testid="http-path-add"
        >
          {t('paths.add')}
        </Button>
      </form>
    </section>
  );
}
