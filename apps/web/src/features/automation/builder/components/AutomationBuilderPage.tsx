import {
  AUTOMATION_TRIGGER_TYPES,
  type AutomationAction,
  type AutomationDefinition,
  type AutomationDto,
  type AutomationTriggerType,
} from '@cellhive/contracts';
import { Button, cn, Input, Skeleton, Spinner, Switch, Tooltip } from '@cellhive/ui';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy, Info, Lock, PencilLine } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';

import { useDocumentTitle } from '../../../../lib/a11y/use-document-title';
import { automationsApi } from '../../../../lib/api/automations';
import { isApiError } from '../../../../lib/api/client';
import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { PageHeader } from '../../../../lib/layout/page-header';
import { canManageAutomations, isBaseAdmin } from '../../../../lib/permissions/access';
import { isOrgAdmin } from '../../../../lib/permissions/org';
import { automationQuery } from '../../../../lib/query/automations';
import { incomingWebhooksQuery } from '../../../../lib/query/incoming-webhooks';
import { keys } from '../../../../lib/query/keys';
import {
  baseQuery,
  fieldsQuery,
  orgQuery,
  tablesQuery,
  viewsQuery,
} from '../../../../lib/query/queries';
import { meQuery } from '../../../../lib/session/session';
import { showErrorToast, showToast } from '../../../../lib/toast/toast';
import { useDuplicateAutomation } from '../../list/use-duplicate-automation';
import { AutomationTabs } from '../../runs/components/AutomationTabs';
import { baseEmailIdentitiesQuery, builderEmailSettingsQuery } from '../actions/send-email/queries';
import { checkDraft, conditionSlot, type ConditionSlotState } from '../model/check';
import {
  asFieldId,
  asTableId,
  findPlaced,
  isUnset,
  NO_TABLE,
  insertAction,
  moveAction,
  moveActionTo,
  newAction,
  newActionId,
  placedActions,
  removeAction,
  replaceAction,
  sameDefinition,
  switchTrigger,
  hasTriggerRecord,
  type AddableActionType,
  type ListRef,
  type TableId,
} from '../model/draft';
import {
  firstIssueStep,
  issuesFromProblem,
  type BuilderIssue,
  type StepKey,
} from '../model/issues';
import { scopeOf, triggerTableOf } from '../model/scope';
import { sampleQuery } from '../triggers/webhook/queries';

import {
  ConflictDialog,
  DeleteStepDialog,
  IssueSummary,
  LeaveDialog,
  RunAsBanner,
} from './BuilderBanners';
import { ConfigPanel } from './ConfigPanel';
import { BuilderEnvContext, type BuilderEnv } from './env';
import { FlowCanvas } from './flow/FlowCanvas';

import type { AutomationConditionEditorProps } from '../../../../lib/automation/condition-editor';
import type { WebhookKit } from '../../../../lib/automation/webhook-kit';

const NARROW_QUERY = '(max-width: 767.98px)';

/** (T522) The wide editor of `send_email`: a chunk of its own, loaded when such a step opens. */
const SendEmailEditor = lazy(() => import('../actions/send-email/SendEmailEditor'));
/** "Turn on automation?" of the list: loaded when it is asked (keeps `Trans` out of the builder). */
const EnableDialog = lazy(async () => ({
  default: (await import('../../list/components/ConfirmDialogs')).EnableDialog,
}));

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener('change', listener);
  return () => {
    media.removeEventListener('change', listener);
  };
}

function isNarrow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/** Phones (< 768 px) look and turn on/off only (FRONTEND §13.2). */
function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export interface AutomationBuilderPageProps {
  /** The view filter builder in automation mode, given by the route (FRONTEND §1.2). */
  readonly ConditionEditor: ComponentType<AutomationConditionEditorProps>;
  /** (T612) The incoming webhook dialogs of `features/integrations`, given by the route. */
  readonly webhookKit: WebhookKit;
}

/** What `/b/:baseId/automations/new` starts with: the create dialog's name and trigger. */
interface NewSpec {
  readonly name: string;
  readonly type: AutomationTriggerType;
  readonly tableId: string;
  /** (T525) The button of a `button.clicked` trigger ("Create an automation for this button"). */
  readonly fieldId: string;
}

function newSpecOf(search: URLSearchParams): NewSpec {
  const type = search.get('trigger');
  return {
    name: search.get('name') ?? '',
    type: (AUTOMATION_TRIGGER_TYPES as readonly string[]).includes(type ?? '')
      ? (type as AutomationTriggerType)
      : 'record.created',
    tableId: search.get('table') ?? '',
    fieldId: search.get('field') ?? '',
  };
}

function Message({
  title,
  children,
  icon: Icon = Lock,
}: {
  readonly title: string;
  readonly children?: React.ReactNode;
  readonly icon?: typeof Lock;
}) {
  return (
    <section
      className="m-4 flex flex-col items-start gap-2.5 rounded-lg border border-line bg-surface p-6 sm:m-6"
      data-testid="builder-message"
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <h1 className="text-heading">{title}</h1>
      {children}
    </section>
  );
}

/**
 * `/b/:baseId/automations/:automationId` and `/…/new` (T521, FRONTEND
 * §13.2; boards "S5 · Automation builder", "… - tối", "… - trigger và
 * điều kiện", "… - action"): who may manage automations of the base sees
 * the builder; others why not (the API answers `403`); an automation that
 * does not exist or is not theirs to manage is a 404 message.
 */
export function AutomationBuilderPage({ ConditionEditor, webhookKit }: AutomationBuilderPageProps) {
  const { t } = useTranslation(['automationBuilder', 'automation']);
  const { baseId = '', automationId } = useParams();
  const [search] = useSearchParams();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const manages = canManageAutomations(base.access);
  const existing = useQuery({
    ...automationQuery(baseId, automationId ?? ''),
    enabled: manages && automationId !== undefined,
    retry: (count, error) =>
      !(isApiError(error) && (error.status === 403 || error.status === 404)) && count < 2,
    // The builder keeps its own draft: no refetch under the user's feet.
    refetchOnWindowFocus: false,
  });
  const spec = useMemo(() => newSpecOf(search), [search]);
  // A new automation starts on the first table the caller manages: wait for the list.
  const tables = useQuery({
    ...tablesQuery(baseId),
    enabled: manages && automationId === undefined,
  });

  if (!manages || (isApiError(existing.error) && existing.error.status === 403)) {
    return (
      <Message title={t('automation:forbidden.title')}>
        <p className="max-w-[60ch] text-body text-fg-muted">
          {t('automation:forbidden.description')}
        </p>
      </Message>
    );
  }
  if (automationId !== undefined) {
    if (isApiError(existing.error) && existing.error.status === 404) {
      return (
        <Message title={t('page.notFound')}>
          <Link to={`/b/${baseId}/automations`} className="text-body text-accent underline">
            {t('page.backToList')}
          </Link>
        </Message>
      );
    }
    if (existing.isError) {
      return (
        <div className="p-6">
          <ErrorAlert error={existing.error} />
        </div>
      );
    }
  }
  if (
    (automationId !== undefined && existing.data === undefined) ||
    (automationId === undefined && tables.data === undefined && !tables.isError)
  ) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t('page.loading')}
        className="flex flex-col items-center gap-3 p-6"
      >
        <Skeleton className="h-20 w-full max-w-[600px]" />
        <Skeleton className="h-16 w-full max-w-[600px]" />
        <Skeleton className="h-16 w-full max-w-[600px]" />
      </div>
    );
  }
  const firstManaged =
    tables.data?.items.find((table) => canManageAutomations(base.access, table.id))?.id ?? NO_TABLE;
  return (
    <Builder
      key={existing.data?.id ?? 'new'}
      baseId={baseId}
      automation={existing.data ?? null}
      spec={spec}
      firstTable={firstManaged}
      ConditionEditor={ConditionEditor}
      webhookKit={webhookKit}
    />
  );
}

export default AutomationBuilderPage;

interface BuilderProps {
  readonly baseId: string;
  readonly automation: AutomationDto | null;
  readonly spec: NewSpec;
  /** Table a new automation starts on (the first the caller manages). */
  readonly firstTable: TableId;
  readonly ConditionEditor: AutomationBuilderPageProps['ConditionEditor'];
  readonly webhookKit: WebhookKit;
}

function initialDefinition(spec: NewSpec, firstTable: TableId): AutomationDefinition {
  const table = isUnset(spec.tableId) ? firstTable : asTableId(spec.tableId);
  const trigger = switchTrigger(
    { type: 'record.created', table_id: table, skip_bulk: false },
    spec.type,
    table,
  );
  return {
    trigger:
      trigger.type === 'button.clicked' && spec.fieldId !== ''
        ? { ...trigger, field_id: asFieldId(spec.fieldId) }
        : trigger,
    condition: null,
    actions: [],
  };
}

function Builder({
  baseId,
  automation,
  spec,
  firstTable,
  ConditionEditor,
  webhookKit,
}: BuilderProps) {
  const { t } = useTranslation(['automationBuilder', 'automation']);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const { data: base } = useSuspenseQuery(baseQuery(baseId));
  const me = useQuery(meQuery());
  const meId = me.data?.user.id ?? null;
  const org = useQuery(orgQuery(base.organization_id));
  const tables = useQuery(tablesQuery(baseId));
  const tableItems = useMemo(() => tables.data?.items ?? [], [tables.data]);
  const fieldLists = useQueries({ queries: tableItems.map((table) => fieldsQuery(table.id)) });
  const managedTables = tableItems.filter((table) => canManageAutomations(base.access, table.id));
  // (T522) No instance SMTP and no identity of the base: `send_email` cannot send anything.
  const orgAdmin = isOrgAdmin(me.data?.orgs.find((item) => item.id === base.organization_id)?.role);
  const emailSettings = useQuery(
    builderEmailSettingsQuery(base.organization_id, orgAdmin && !narrow),
  );
  const baseIdentities = useQuery({
    ...baseEmailIdentitiesQuery(baseId),
    enabled: orgAdmin && !narrow,
  });
  const emailUnavailable =
    emailSettings.data?.smtp.configured === false && baseIdentities.data?.items.length === 0;
  const orgSlug = me.data?.orgs.find((item) => item.id === base.organization_id)?.slug ?? null;
  const viewLists = useQueries({ queries: managedTables.map((table) => viewsQuery(table.id)) });

  const [saved, setSaved] = useState<AutomationDto | null>(automation);
  const [name, setName] = useState(automation?.name ?? spec.name);
  const [definition, setDefinition] = useState<AutomationDefinition>(
    () => automation?.definition ?? initialDefinition(spec, firstTable),
  );
  const [selected, setSelected] = useState<StepKey | null>('trigger');
  const [issues, setIssues] = useState<BuilderIssue[]>([]);
  const [conditions, setConditions] = useState<ReadonlyMap<string, ConditionSlotState>>(new Map());
  const [resetKey, setResetKey] = useState(0);
  const [renaming, setRenaming] = useState(saved === null && spec.name === '');
  const [conflict, setConflict] = useState<{ by: string | null; version: number } | null>(null);
  const [deleting, setDeleting] = useState<AutomationAction | null>(null);
  const [asking, setAsking] = useState(false);
  const leaving = useRef(false);
  const nameId = useId();

  const fieldsByTable = useMemo(() => {
    const map = new Map<string, NonNullable<(typeof fieldLists)[number]['data']>['items']>();
    tableItems.forEach((table, index) => {
      const items = fieldLists[index]?.data?.items;
      if (items !== undefined) map.set(table.id, items);
    });
    return map;
  }, [tableItems, fieldLists]);
  const forms = useMemo(
    () =>
      viewLists.flatMap(
        (query) =>
          query.data?.items.filter((view) => view.type === 'form' && !view.is_personal) ?? [],
      ),
    [viewLists],
  );
  // (T612) `webhook.received`: the hooks of the base (names) and the sample of the trigger's hook.
  const webhookTrigger = definition.trigger.type === 'webhook.received';
  const webhookId =
    definition.trigger.type === 'webhook.received' &&
    !isUnset(definition.trigger.incoming_webhook_id)
      ? definition.trigger.incoming_webhook_id
      : null;
  const baseAdmin = isBaseAdmin(base.access);
  const webhooks = useQuery({
    ...incomingWebhooksQuery(baseId),
    enabled: baseAdmin && webhookTrigger,
  });
  const webhookSample = useQuery({
    ...sampleQuery(baseId, webhookId ?? ''),
    enabled: baseAdmin && webhookId !== null && !narrow,
  });
  const triggerTableId = triggerTableOf(
    definition.trigger,
    (viewId) => forms.find((view) => view.id === viewId)?.table_id,
  );
  const scopeFor = useCallback(
    (actionId: string | null) => scopeOf(definition, actionId, triggerTableId),
    [definition, triggerTableId],
  );

  const definitionChanged = saved === null || !sameDefinition(definition, saved.definition);
  const nameChanged = saved === null || name.trim() !== saved.name;
  const dirty = definitionChanged || nameChanged;

  const env: BuilderEnv = useMemo(
    () => ({
      base,
      orgId: base.organization_id,
      orgTimeZone: org.data?.settings.timezone ?? browserZone(),
      meId,
      automationId: saved?.id ?? null,
      runAsName:
        saved !== null && !definitionChanged
          ? saved.run_as.name
          : (me.data?.user.display_name ?? null),
      tables: tableItems,
      tableName: (id: string) => tableItems.find((table) => table.id === id)?.name,
      fieldsOf: (id: string) => fieldsByTable.get(id),
      webhookSample: webhookId === null ? null : (webhookSample.data?.sample ?? null),
      webhookName: (id: string) => webhooks.data?.items.find((hook) => hook.id === id)?.name,
      forms,
      issues,
      readOnly: narrow,
      emailUnavailable,
      emailSettingsPath: orgAdmin && orgSlug !== null ? `/o/${orgSlug}/settings/email` : null,
      ConditionEditor,
      webhookKit,
      setConditionState: (slot, state) => {
        setConditions((current) => {
          const next = new Map(current);
          if (state === null) next.delete(slot);
          else next.set(slot, state);
          return next;
        });
      },
      resetKey,
    }),
    [
      base,
      org.data,
      meId,
      saved,
      definitionChanged,
      me.data,
      tableItems,
      fieldsByTable,
      webhookId,
      webhookSample.data,
      webhooks.data,
      forms,
      issues,
      narrow,
      emailUnavailable,
      orgAdmin,
      orgSlug,
      ConditionEditor,
      webhookKit,
      resetKey,
    ],
  );
  useDocumentTitle(
    `${name.trim() === '' ? t('page.untitled') : name} · ${t('automation:page.title')}`,
  );

  // --- Saving -------------------------------------------------------------------------
  const goTo = useCallback(
    (step: StepKey) => {
      if (step === 'general') {
        document.getElementById(nameId)?.focus();
        return;
      }
      setSelected(step);
      window.setTimeout(() => {
        const card = document.querySelector<HTMLElement>(`[data-step="${step}"]`);
        // jsdom has no scrollIntoView.
        if (card !== null && 'scrollIntoView' in card) card.scrollIntoView({ block: 'center' });
      }, 0);
    },
    [nameId],
  );

  const save = useMutation({
    mutationFn: async (version: number | null) => {
      const trimmed = name.trim();
      if (saved === null) {
        return automationsApi.create(baseId, { name: trimmed, definition, enabled: false });
      }
      return automationsApi.update(saved.id, version ?? saved.version, {
        ...(trimmed === saved.name ? {} : { name: trimmed }),
        ...(definitionChanged ? { definition } : {}),
      });
    },
    onSuccess: async (next) => {
      setIssues([]);
      setConflict(null);
      queryClient.setQueryData(keys.automation(baseId, next.id), next);
      await queryClient.invalidateQueries(
        { queryKey: keys.automations(baseId), exact: true },
        { cancelRefetch: false },
      );
      showToast({ variant: 'success', message: t('save.done', { name: next.name }) });
      if (saved === null) {
        leaving.current = true;
        void navigate(`/b/${baseId}/automations/${next.id}`, { replace: true });
        return;
      }
      setSaved(next);
      setName(next.name);
      setDefinition(next.definition);
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 409) {
        const params = error.errors[0]?.params as
          { current_version?: number; updated_by?: { name?: string } | null } | undefined;
        setConflict({
          by: params?.updated_by?.name ?? null,
          version: params?.current_version ?? saved?.version ?? 1,
        });
        return;
      }
      if (isApiError(error) && error.status === 422 && error.errors.length > 0) {
        const found = issuesFromProblem(definition, error.errors);
        setIssues(found);
        const first = firstIssueStep(definition, found);
        if (first !== null) goTo(first);
        return;
      }
      if (isApiError(error) && error.status === 404) {
        showToast({ variant: 'warning', message: t('automation:toast.gone', { name }) });
        leaving.current = true;
        void navigate(`/b/${baseId}/automations`);
        return;
      }
      showErrorToast(error);
    },
  });

  const submit = (version: number | null = null) => {
    if (narrow || save.isPending) return;
    const found = checkDraft(definition, {
      name,
      conditions,
      orgTimeZone: env.orgTimeZone,
      now: new Date(),
    });
    setIssues(found);
    if (found.length > 0) {
      const first = firstIssueStep(definition, found);
      if (first !== null) goTo(first);
      return;
    }
    save.mutate(version);
  };

  const discard = () => {
    if (saved === null) {
      leaving.current = true;
      void navigate(`/b/${baseId}/automations`);
      return;
    }
    setName(saved.name);
    setDefinition(saved.definition);
    setIssues([]);
    setConditions(new Map());
    setResetKey((key) => key + 1);
  };

  // Ctrl/⌘+S saves (and keeps the browser's "save page" away).
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        submitRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Unsaved changes: ask before leaving the page or closing the tab.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !narrow && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty || narrow) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty, narrow]);

  // --- Turning on/off (header switch) -------------------------------------------------
  const toggle = useMutation({
    mutationFn: (on: boolean) => {
      if (saved === null) throw new Error('not saved');
      return on
        ? automationsApi.enable(saved.id, saved.version)
        : automationsApi.disable(saved.id, saved.version);
    },
    onSuccess: (next) => {
      setSaved(next);
      setAsking(false);
      queryClient.setQueryData(keys.automation(baseId, next.id), next);
      void queryClient.invalidateQueries({ queryKey: keys.automations(baseId), exact: true });
      showToast({
        variant: 'success',
        message: t(next.enabled ? 'automation:toast.enabled' : 'automation:toast.disabled', {
          name: next.name,
        }),
      });
    },
    onError: (error) => {
      setAsking(false);
      if (isApiError(error) && error.status === 409) {
        showToast({ variant: 'warning', message: t('automation:toast.conflict', { name }) });
        void queryClient.invalidateQueries({ queryKey: keys.automation(baseId, saved?.id ?? '') });
        return;
      }
      showErrorToast(error);
    },
  });

  // --- Edits -------------------------------------------------------------------------
  const change = (next: AutomationDefinition) => {
    setDefinition(next);
  };
  const add = (type: AddableActionType, list: ListRef, index: number) => {
    const id = newActionId(definition);
    const action = newAction(type, id, { triggerTableId, firstTableId: tableItems[0]?.id ?? null });
    change(insertAction(definition, list, index, action));
    setSelected(id as StepKey);
  };
  const remove = (action: AutomationAction) => {
    const placed = findPlaced(definition, action.id);
    const next = removeAction(definition, action.id);
    change(next);
    setDeleting(null);
    if (selected === action.id) setSelected(null);
    // The focus goes to the card that took its place, else the trigger.
    window.setTimeout(() => {
      const ids = placedActions(next).map((item) => item.action.id);
      const target =
        ids[
          Math.min(
            placed === undefined ? 0 : placedActions(definition).indexOf(placed),
            ids.length - 1,
          )
        ];
      document.querySelector<HTMLElement>(`[data-step-button="${target ?? 'trigger'}"]`)?.focus();
    }, 0);
  };

  const stepLabel = (step: StepKey): string => {
    if (step === 'general') return t('issues.general');
    if (step === 'trigger') return t('panel.trigger');
    if (step === 'condition') return t('panel.condition');
    const placed = findPlaced(definition, step);
    return t('flow.step', { number: placed?.number ?? '?' });
  };

  const closePanel = () => {
    const step = selected;
    setSelected(null);
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-step-button="${step ?? 'trigger'}"]`)?.focus();
    }, 0);
  };
  // (T522) A `send_email` step opens the wide editor instead of the 440 px panel.
  const selectedPlaced =
    selected !== null && selected.startsWith('act_') ? findPlaced(definition, selected) : undefined;
  const emailStep =
    selectedPlaced?.action.type === 'send_email'
      ? { action: selectedPlaced.action, number: selectedPlaced.number }
      : null;

  const canToggle = saved !== null && !dirty && !toggle.isPending;
  const enabled = saved?.enabled ?? false;
  const switchId = useId();
  const switchHint = useId();
  // T556: "Duplicate" copies the saved version (T551), so not while changes are unsaved.
  const duplicate = useDuplicateAutomation(baseId, { linkToSource: false });
  const duplicateHint = useId();

  return (
    <BuilderEnvContext.Provider value={env}>
      <PageHeader>
        <Tooltip content={t('page.back')}>
          <Button asChild variant="ghost" size="icon" className="size-8 max-lg:size-control">
            <Link to={`/b/${baseId}/automations`} aria-label={t('page.back')}>
              <ChevronLeft aria-hidden="true" />
            </Link>
          </Button>
        </Tooltip>
        <nav
          aria-label={t('automation:page.breadcrumb')}
          className="flex min-w-0 shrink items-center gap-1.5"
        >
          <span className="text-body text-fg-muted max-md:hidden">
            {t('automation:page.title')}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-subtle max-md:hidden"
          />
          {renaming && !narrow ? (
            <Input
              id={nameId}
              autoFocus
              value={name}
              maxLength={255}
              aria-label={t('page.name')}
              className="h-8 w-56 max-lg:h-control"
              data-testid="builder-name"
              onChange={(event) => {
                setName(event.target.value);
              }}
              onBlur={() => {
                if (name.trim() !== '') setRenaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim() !== '') {
                  event.preventDefault();
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <>
              <h1 className="min-w-0 truncate text-heading" data-testid="builder-title">
                {name.trim() === '' ? t('page.untitled') : name}
              </h1>
              {narrow ? null : (
                <Tooltip content={t('page.rename')}>
                  <Button
                    id={nameId}
                    variant="ghost"
                    size="icon"
                    className="size-8 max-lg:size-control"
                    aria-label={t('page.rename')}
                    onClick={() => {
                      setRenaming(true);
                    }}
                  >
                    <PencilLine aria-hidden="true" />
                  </Button>
                </Tooltip>
              )}
            </>
          )}
        </nav>
        {saved === null ? null : (
          <span className="flex shrink-0 items-center gap-2">
            <Switch
              id={switchId}
              checked={enabled}
              disabled={!canToggle}
              aria-describedby={dirty ? switchHint : undefined}
              data-testid="builder-enabled"
              onChange={(event) => {
                const on = event.target.checked;
                if (on && saved.run_as.id !== meId) setAsking(true);
                else toggle.mutate(on);
              }}
            />
            <label htmlFor={switchId} className="text-body whitespace-nowrap max-sm:sr-only">
              {enabled ? t('page.on') : t('page.off')}
            </label>
            {dirty ? (
              <span id={switchHint} className="sr-only">
                {t('page.saveFirst')}
              </span>
            ) : null}
          </span>
        )}
        {/* T523: "Configuration | Run history" of a saved automation (below the header on phones). */}
        {saved === null || narrow ? null : (
          <AutomationTabs baseId={baseId} automationId={saved.id} current="config" />
        )}
        {narrow ? null : (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {dirty ? (
              <span
                className="inline-flex h-[22px] items-center gap-1 rounded-sm bg-option-3 px-2 text-label text-on-option-3 max-lg:hidden"
                data-testid="builder-unsaved"
              >
                <PencilLine aria-hidden="true" className="size-3" />
                {saved === null ? t('page.new') : t('page.unsaved')}
              </span>
            ) : null}
            {saved === null ? null : (
              <>
                <Button
                  variant="ghost"
                  disabled={dirty || duplicate.pendingId !== null}
                  aria-describedby={dirty ? duplicateHint : undefined}
                  data-testid="builder-duplicate"
                  onClick={() => {
                    duplicate.duplicate(saved);
                  }}
                >
                  {duplicate.pendingId === null ? <Copy aria-hidden="true" /> : <Spinner />}
                  <span className="max-lg:sr-only">{t('automation:row.duplicate')}</span>
                </Button>
                {dirty ? (
                  <span id={duplicateHint} className="sr-only">
                    {t('automation:duplicate.saveFirst')}
                  </span>
                ) : null}
              </>
            )}
            {dirty ? (
              <Button variant="ghost" onClick={discard} data-testid="builder-discard">
                {saved === null ? t('page.cancel') : t('page.discard')}
              </Button>
            ) : null}
            <Button
              onClick={() => {
                submit();
              }}
              disabled={save.isPending || !dirty}
              data-testid="builder-save"
            >
              {save.isPending ? <Spinner /> : null}
              {saved === null ? t('page.create') : t('page.save')}
            </Button>
          </div>
        )}
      </PageHeader>

      <div className="relative flex h-[calc(100dvh-3.25rem)] min-h-80 flex-col overflow-x-clip bg-canvas">
        {/* T527: in the 375 px top bar the tabs left no room for the name and ran under the bell. */}
        {narrow && saved !== null ? (
          <div className="border-b border-line bg-surface px-4 py-2">
            <AutomationTabs baseId={baseId} automationId={saved.id} current="config" />
          </div>
        ) : null}
        {narrow ? (
          <p className="flex items-center gap-2 bg-surface-sunken px-4 py-2.5 text-label font-normal text-fg-muted">
            <Info aria-hidden="true" className="size-3.5 shrink-0" />
            {t('automation:page.mobileNote')}
          </p>
        ) : null}
        {saved !== null && meId !== null && saved.run_as.id !== meId ? (
          <RunAsBanner
            automation={saved}
            definition={definition}
            definitionChanged={definitionChanged}
          />
        ) : null}
        {saved?.disabled_reason === null || saved?.disabled_reason === undefined ? null : (
          <p
            role="note"
            className={cn(
              'border-b px-4 py-2 text-label font-normal text-fg',
              saved.disabled_reason === 'circuit_breaker'
                ? 'border-danger/40 bg-danger/5'
                : 'border-warning/40 bg-option-3',
            )}
          >
            {t(`automation:disabled.${saved.disabled_reason}.title`, { name: saved.run_as.name })}
          </p>
        )}
        {emailStep !== null && !narrow ? (
          <Suspense
            fallback={
              <div role="status" aria-busy="true" aria-label={t('page.loading')} className="p-6">
                <Skeleton className="h-64 w-full max-w-[680px]" />
              </div>
            }
          >
            <SendEmailEditor
              key={emailStep.action.id}
              action={emailStep.action}
              number={emailStep.number}
              definition={definition}
              scope={scopeFor(emailStep.action.id)}
              automationId={saved?.id ?? null}
              onChange={(action) => {
                change(replaceAction(definition, action));
              }}
              onClose={closePanel}
            />
          </Suspense>
        ) : (
          <div className="relative flex min-h-0 flex-1">
            <div
              className="min-w-0 flex-1 overflow-auto px-4 py-6 sm:px-6"
              data-testid="builder-canvas"
            >
              <IssueSummary
                issues={issues}
                definition={definition}
                stepLabel={stepLabel}
                onGoTo={goTo}
              />
              <FlowCanvas
                definition={definition}
                selected={selected}
                triggerTableId={triggerTableId}
                scopeOf={scopeFor}
                onSelect={(step) => {
                  setSelected(step);
                }}
                onAdd={add}
                onMove={(id, delta) => {
                  const next = moveAction(definition, id, delta);
                  if (next === null) return;
                  change(next);
                  window.setTimeout(() => {
                    document.querySelector<HTMLElement>(`[data-step-button="${id}"]`)?.focus();
                  }, 0);
                }}
                onMoveTo={(id, overId) => {
                  const next = moveActionTo(definition, id, overId);
                  if (next !== null) change(next);
                }}
                onDelete={(action) => {
                  if (
                    action.type === 'if' &&
                    action.config.then.length + action.config.else.length > 0
                  ) {
                    setDeleting(action);
                  } else {
                    remove(action);
                  }
                }}
              />
            </div>
            {selected === null || narrow ? null : (
              <ConfigPanel
                step={selected}
                definition={definition}
                triggerTableId={triggerTableId}
                scopeOf={scopeFor}
                onTrigger={(trigger) => {
                  // A trigger without record has no condition (`webhook.received`: `INVALID_CONDITION`).
                  const recordless = !hasTriggerRecord(trigger);
                  if (recordless && definition.condition !== null) {
                    setConditions((current) => {
                      const next = new Map(current);
                      next.delete(conditionSlot('condition', ''));
                      return next;
                    });
                  }
                  change({
                    ...definition,
                    trigger,
                    condition: recordless ? null : definition.condition,
                  });
                }}
                onCondition={(condition) => {
                  change({ ...definition, condition });
                }}
                onAction={(action) => {
                  change(replaceAction(definition, action));
                }}
                onClose={closePanel}
              />
            )}
          </div>
        )}
      </div>

      {conflict === null ? null : (
        <ConflictDialog
          by={conflict.by}
          pending={save.isPending}
          onCancel={() => {
            setConflict(null);
          }}
          onReload={() => {
            setConflict(null);
            void queryClient
              .query({ ...automationQuery(baseId, saved?.id ?? ''), staleTime: 0 })
              .then((fresh) => {
                setSaved(fresh);
                setName(fresh.name);
                setDefinition(fresh.definition);
                setIssues([]);
                setConditions(new Map());
                setResetKey((key) => key + 1);
              })
              .catch(showErrorToast);
          }}
          onOverwrite={() => {
            const version = conflict.version;
            if (saved !== null) setSaved({ ...saved, version });
            submit(version);
          }}
        />
      )}
      {deleting === null ? null : (
        <DeleteStepDialog
          title={t(`actionType.${deleting.type}` as 'actionType.if')}
          count={
            deleting.type === 'if' ? deleting.config.then.length + deleting.config.else.length : 0
          }
          onCancel={() => {
            setDeleting(null);
          }}
          onConfirm={() => {
            remove(deleting);
          }}
        />
      )}
      {asking && saved !== null ? (
        <Suspense fallback={null}>
          <EnableDialog
            automation={saved}
            baseName={base.name}
            pending={toggle.isPending}
            onCancel={() => {
              setAsking(false);
            }}
            onConfirm={() => {
              toggle.mutate(true);
            }}
          />
        </Suspense>
      ) : null}
      {duplicate.dialog}
      {blocker.state === 'blocked' ? (
        <LeaveDialog
          onStay={() => {
            blocker.reset();
          }}
          onLeave={() => {
            blocker.proceed();
          }}
        />
      ) : null}
    </BuilderEnvContext.Provider>
  );
}
