import { Button, Skeleton, Tooltip } from '@cellhive/ui';
import { X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { SendNotificationPanel } from '../actions/send-notification/SendNotificationPanel';
import { findPlaced, hasTriggerRecord } from '../model/draft';
import { issuesOf, type StepKey } from '../model/issues';

import { useBuilderEnv } from './env';
import {
  ComingSoonPanel,
  CreateRecordPanel,
  DeleteRecordPanel,
  FindRecordsPanel,
  IfPanel,
  UpdateRecordPanel,
} from './panels/ActionPanels';
import { DelayPanel, UpdateRecordsPanel } from './panels/BulkDelayPanels';
import { IssueText } from './panels/common';
import { ConditionPanel } from './panels/ConditionPanel';
import { SendTelegramPanel } from './panels/SendTelegramPanel';
import { TriggerPanel } from './panels/TriggerPanel';

import type { ValueScope } from '../model/scope';
import type {
  AutomationAction,
  AutomationDefinition,
  AutomationFilter,
  AutomationTrigger,
} from '@cellhive/contracts';

// (T613) The HTTP editors and their strings load with the first HTTP step opened.
const HttpRequestEditor = lazy(() => import('../actions/http-request/HttpRequestEditor'));
const RunN8nWorkflowEditor = lazy(() => import('../actions/run-n8n-workflow/RunN8nWorkflowEditor'));

export interface ConfigPanelProps {
  readonly step: StepKey;
  readonly definition: AutomationDefinition;
  readonly triggerTableId: string | null;
  readonly scopeOf: (actionId: string | null) => ValueScope;
  readonly onTrigger: (trigger: AutomationTrigger) => void;
  readonly onCondition: (filter: AutomationFilter | null) => void;
  readonly onAction: (action: AutomationAction) => void;
  readonly onClose: () => void;
}

/**
 * The settings of the selected card (board "S5 · Automation builder"): a
 * 440 px panel at the right (an overlay below 1024 px). Its heading takes
 * the focus when it opens; Escape or × closes it and gives the focus back
 * to the card.
 */
export function ConfigPanel({
  step,
  definition,
  triggerTableId,
  scopeOf,
  onTrigger,
  onCondition,
  onAction,
  onClose,
}: ConfigPanelProps) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const placed = step.startsWith('act_') ? findPlaced(definition, step) : undefined;
  const action = placed?.action;
  const title =
    step === 'trigger'
      ? t('panel.trigger')
      : step === 'condition'
        ? t('panel.condition')
        : action === undefined
          ? ''
          : t('panel.step', {
              number: placed?.number ?? '',
              type: t(`actionType.${action.type}` as 'actionType.if'),
            });
  const generalIssues = issuesOf(env.issues, step).filter((issue) => issue.path === '');

  let body = null;
  if (step === 'trigger') {
    body = <TriggerPanel definition={definition} onChange={onTrigger} />;
  } else if (step === 'condition') {
    body = (
      <ConditionPanel
        tableId={hasTriggerRecord(definition.trigger) ? triggerTableId : null}
        changeOperators={definition.trigger.type === 'record.updated'}
        value={definition.condition}
        onChange={onCondition}
      />
    );
  } else if (action !== undefined) {
    const scope = scopeOf(action.id);
    const props = { definition, scope, onChange: onAction };
    switch (action.type) {
      case 'create_record':
        body = <CreateRecordPanel action={action} {...props} />;
        break;
      case 'update_record':
        body = <UpdateRecordPanel action={action} {...props} />;
        break;
      case 'find_records':
        body = <FindRecordsPanel action={action} {...props} />;
        break;
      case 'delete_record':
        body = <DeleteRecordPanel scope={scope} />;
        break;
      case 'update_records':
        body = <UpdateRecordsPanel action={action} {...props} />;
        break;
      case 'delay':
        body = <DelayPanel action={action} {...props} />;
        break;
      case 'if':
        body = <IfPanel action={action} {...props} />;
        break;
      case 'send_notification':
        // Its strings are a namespace of their own, loaded on first use.
        body = (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <SendNotificationPanel action={action} {...props} />
          </Suspense>
        );
        break;
      case 'send_telegram':
        body = <SendTelegramPanel action={action} {...props} />;
        break;
      case 'http_request':
        body = (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <HttpRequestEditor action={action} {...props} />
          </Suspense>
        );
        break;
      case 'run_n8n_workflow':
        body = (
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <RunN8nWorkflowEditor action={action} {...props} />
          </Suspense>
        );
        break;
      default:
        body = <ComingSoonPanel type={action.type} />;
    }
  }

  return (
    <aside
      aria-labelledby="config-panel-title"
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-popover lg:static lg:z-auto lg:w-[440px] lg:shrink-0 lg:shadow-none"
      data-testid="config-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex min-h-[52px] items-center gap-2 border-b border-line px-5 py-2">
        <h2
          id="config-panel-title"
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-heading outline-none"
        >
          {title}
        </h2>
        <Tooltip content={t('panel.close')}>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 max-lg:size-control"
            aria-label={t('panel.close')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4" key={step}>
        <IssueText id="config-panel-issues" issues={generalIssues} />
        {body}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-5 py-3 text-label font-normal text-fg-muted max-lg:hidden">
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> {t('panel.keysMove')} <Kbd>{KEY_ENTER}</Kbd> {t('panel.keysOpen')}{' '}
        <Kbd>{KEY_ALT}</Kbd>+<Kbd>↑</Kbd> {t('panel.keysReorder')}
      </p>
    </aside>
  );
}

const KEY_ENTER = 'Enter';
const KEY_ALT = 'Alt';

function Kbd({ children }: { readonly children: string }) {
  return (
    <kbd className="rounded-sm border border-line-strong bg-surface-sunken px-1 font-code text-label text-fg">
      {children}
    </kbd>
  );
}
