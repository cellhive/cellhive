import { lazy, Suspense } from 'react';
import { createBrowserRouter, useParams, type RouteObject } from 'react-router';

import { RouteErrorPage, RouteErrorPanel } from './errors';
import { createGuards } from './guards';
import { HydrateFallback, PageLoading, RootLayout } from './layouts/RootLayout';
import { NotFoundPage } from './NotFoundPage';

import type { LinkComponents } from '../lib/links/picker';
import type { RecordDetailComponents } from '../lib/records/detail';
import type { FieldToolsProps } from '../lib/schema/field-tools';
import type { LookupFieldEditorProps } from '../lib/schema/lookup-tools';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Record panel and history (T206): separate lazy chunks, loaded when a
 * record or a cell history is first opened. The grid page receives them
 * (features do not import each other, FRONTEND §1.2).
 */
const RECORD_DETAIL: RecordDetailComponents = {
  Panel: lazy(() => import('../features/record/components/RecordPanel')),
  History: lazy(() => import('../features/history/components/RecordHistory')),
  CellHistory: lazy(() => import('../features/history/components/CellHistoryPopover')),
  // Attachment popover of the grid and section of the panel (T418): chunks of their own.
  Attachments: {
    CellEditor: lazy(() => import('../features/attachment/components/AttachmentCellEditor')),
    Section: lazy(() => import('../features/attachment/components/AttachmentSection')),
  },
};

/**
 * Link picker and linked-record hover card (T413): one lazy chunk, loaded
 * ahead when a grid has link columns (`preload`) so the picker opens at once.
 */
const loadLink = () => import('../features/link/components/LinkPicker');
const LINK: LinkComponents = {
  Picker: lazy(async () => ({ default: (await loadLink()).LinkPicker })),
  HoverCard: lazy(async () => ({ default: (await loadLink()).LinkHoverCard })),
  preload: () => {
    void loadLink();
  },
};

/**
 * The formula part of the field dialog (T466): its own chunk, loaded when a
 * formula field is configured; the CodeMirror editor is a further chunk
 * loaded when the editor opens (BACKLOG S4b open question #9).
 */
const FormulaField = lazy(() => import('../features/formula/components/FormulaField'));

/**
 * "Edit formula" of a column header (T468, S4b decision #12): the same
 * editor as a popover under the header, a chunk of its own with CodeMirror.
 */
const FormulaPopover = lazy(() => import('../features/formula/components/FormulaPopover'));

/** The board of kanban views (T314): its own chunk, loaded when a kanban view opens. */
const KanbanPage = lazy(() => import('../features/kanban/components/KanbanPage'));

/** Builder and fill page of form views (T315): its own chunk, loaded when a form view opens. */
const FormViewPage = lazy(() => import('../features/form/components/FormViewPage'));

/**
 * (T521, T612) The automation builder and what it gets from other features
 * (FRONTEND §1.2), composed in `automation-builder-route.tsx`: its own small
 * chunk, so the shell only holds this one import.
 */
const loadAutomationBuilderRoute = () =>
  import('./automation-builder-route').then((module) => module.loadAutomationBuilderRoute());

/**
 * The view screen (`features/view`) shows the grid (`features/grid`) of grid
 * views, and the grid gets the field configuration (T207) from here: features
 * do not import each other (FRONTEND §1.2). Separate chunks.
 */
const loadTableViewRoute = async () => {
  const [
    { TableViewPage },
    { GridPage },
    { FieldTools },
    { ViewToolbar, ViewSearch },
    { SummaryBar },
    { RecordFilterEditor },
    { LookupConditionEditor },
    { LookupFieldEditor },
    { ShareButton },
    { ExportMenu },
    { ImportMenu },
  ] = await Promise.all([
    import('../features/view/components/TableViewPage'),
    import('../features/grid/components/GridPage'),
    import('../features/field/components/FieldTools'),
    // Filter, sort and search of the view (T311).
    import('../features/view/toolbar/ViewToolbar'),
    // The summary bar under the grid (T472).
    import('../features/view/summary/SummaryBar'),
    // Conditions of link fields in the field dialog (T413): the view filter builder.
    import('../features/view/toolbar/RecordFilterEditor'),
    // Lookup fields (T467): their configuration, conditions with the view filter's value editors.
    import('../features/view/toolbar/LookupConditionEditor'),
    import('../features/lookup/components/LookupFieldEditor'),
    import('../features/share/manage/components/ShareButton'),
    // Export of the view and import into the table (T318); the import wizard is lazy.
    import('../features/export/components/ExportMenu'),
    import('../features/import/components/ImportMenu'),
  ]);
  const viewToolbar = { Controls: ViewToolbar, Search: ViewSearch, SummaryBar };
  const LookupEditor = (props: LookupFieldEditorProps) => (
    <LookupFieldEditor {...props} WhereEditor={LookupConditionEditor} />
  );
  const FieldToolsWithFilter = (props: FieldToolsProps) => (
    <FieldTools
      {...props}
      RecordFilterEditor={RecordFilterEditor}
      Formula={FormulaField}
      FormulaPopover={FormulaPopover}
      LookupEditor={LookupEditor}
    />
  );
  return {
    Component: function TableViewRoute() {
      const { baseId = '' } = useParams();
      return (
        <TableViewPage
          renderTableActions={(table) => (
            <ImportMenu baseId={baseId} table={{ id: table.id, name: table.name }} />
          )}
          renderGrid={(view) => (
            // A new grid (rows, selection) per view.
            <GridPage
              key={view.id}
              view={view}
              FieldTools={FieldToolsWithFilter}
              RecordDetail={RECORD_DETAIL}
              ViewToolbar={viewToolbar}
              Link={LINK}
            />
          )}
          renderKanban={(view) => (
            <Suspense fallback={<PageLoading />}>
              <KanbanPage key={view.id} view={view} RecordDetail={RECORD_DETAIL} />
            </Suspense>
          )}
          renderForm={(view) => (
            <Suspense fallback={<PageLoading />}>
              <FormViewPage key={view.id} view={view} />
            </Suspense>
          )}
          renderViewActions={(view, base) => (
            <>
              <ExportMenu baseId={base.id} view={view} />
              <ShareButton view={view} base={base} />
            </>
          )}
        />
      );
    },
  };
};

/**
 * Route map (FRONTEND §2). Every screen is a lazy chunk; loaders are the
 * guards of `guards.ts`. Each route has an error boundary: full-page ones
 * for auth screens, in-shell panels for app pages.
 */
export function createRoutes(queryClient: QueryClient): RouteObject[] {
  const guards = createGuards(queryClient);
  return [
    {
      id: 'root',
      element: <RootLayout />,
      errorElement: <RouteErrorPage />,
      hydrateFallbackElement: <HydrateFallback />,
      children: [
        {
          index: true,
          loader: guards.home,
          lazy: async () => ({
            Component: (await import('../features/org/components/NoOrganizationPage')).default,
          }),
        },
        {
          lazy: async () => ({ Component: (await import('./layouts/AuthLayout')).default }),
          errorElement: <RouteErrorPage />,
          children: [
            {
              path: 'setup',
              loader: guards.setupOnly,
              lazy: async () => ({
                Component: (await import('../features/auth/components/SetupPage')).default,
              }),
            },
            {
              path: 'login',
              loader: guards.guestOnly,
              lazy: async () => ({
                Component: (await import('../features/auth/components/LoginPage')).default,
              }),
            },
            {
              path: 'forgot-password',
              lazy: async () => ({
                Component: (await import('../features/auth/components/ForgotPasswordPage')).default,
              }),
            },
            {
              path: 'reset/:token',
              lazy: async () => ({
                Component: (await import('../features/auth/components/ResetPasswordPage')).default,
              }),
            },
            {
              path: 'invite/:token',
              lazy: async () => ({
                Component: (await import('../features/auth/components/InvitePage')).default,
              }),
            },
          ],
        },
        // T317: the public share page, outside the app shell; no session needed (FRONTEND §2).
        // Loading `/s/*` serves `share.html` (its own entry, `share-main.tsx`); this route
        // serves navigations inside the app, e.g. back from sign-in to an `org` link.
        {
          lazy: async () => ({ Component: (await import('./layouts/ShareLayout')).default }),
          errorElement: <RouteErrorPage />,
          children: [
            {
              path: 's/:token',
              lazy: async () => (await import('./share-routes')).loadShareRoute(),
            },
            // T533: public sender verification (no session), served by the share entry too.
            {
              path: 'verify-sender',
              lazy: async () => (await import('./share-routes')).loadVerifySenderRoute(),
            },
          ],
        },
        {
          loader: guards.requireSession,
          lazy: async () => ({ Component: (await import('./layouts/AppShell')).default }),
          errorElement: <RouteErrorPage />,
          children: [
            {
              path: 'o/:orgSlug',
              loader: guards.org,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/org/components/OrgHomePage')).default,
              }),
            },
            {
              path: 'o/:orgSlug/w/:workspaceId',
              loader: guards.workspace,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/org/components/WorkspacePage')).default,
              }),
            },
            {
              path: 'b/:baseId',
              loader: guards.base,
              errorElement: <RouteErrorPanel />,
              lazy: async () => {
                const [{ BasePage }, { ImportMenu }] = await Promise.all([
                  import('../features/base/components/BasePage'),
                  // "Import a file" as a new table (T318).
                  import('../features/import/components/ImportMenu'),
                ]);
                return {
                  Component: function BaseRoute() {
                    const { baseId = '' } = useParams();
                    return <BasePage actions={<ImportMenu baseId={baseId} />} />;
                  },
                };
              },
            },
            // A table opens its last (or first) view (FRONTEND §2); the same screen shows
            // "no view" when the user sees none.
            ...[
              { path: 'b/:baseId/t/:tableId', loader: guards.tableViews },
              { path: 'b/:baseId/t/:tableId/v/:viewId', loader: guards.view },
            ].map(({ path, loader }) => ({
              path,
              loader,
              errorElement: <RouteErrorPanel />,
              lazy: loadTableViewRoute,
            })),
            // Base settings for base admins (FRONTEND §17, T712): the layout with the "Base
            // settings" nav and its pages. The guard is on the layout so other members get the
            // 404 screen without the nav.
            {
              path: 'b/:baseId/settings',
              loader: guards.baseSettings,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/base-settings/layout/BaseSettingsLayout'))
                  .default,
              }),
              children: [
                // T712: "General", entries to the pages where the base is managed.
                {
                  index: true,
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/base-settings/layout/BaseSettingsGeneralPage')
                    ).default,
                  }),
                },
                // T712: people and groups with their role in the base (CONTRACTS §14).
                {
                  path: 'members',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/base-settings/members/components/MembersPage')
                    ).default,
                  }),
                },
                // T712: the roles of the base (CONTRACTS §14).
                {
                  path: 'roles',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/base-settings/roles/components/RolesPage')
                    ).default,
                  }),
                },
                // T713: the permissions of one role (CONTRACTS §14), with the filter builder.
                {
                  path: 'roles/:roleId',
                  errorElement: <RouteErrorPanel />,
                  lazy: () =>
                    import('./role-editor-route').then((module) => module.loadRoleEditorRoute()),
                },
                // T316: share link management of the base (FRONTEND §2).
                {
                  path: 'share-links',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/share/manage/components/BaseShareLinksPage')
                    ).default,
                  }),
                },
                // T611: incoming webhooks of a base (CONTRACTS §25.1).
                {
                  path: 'webhooks',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/integrations/incoming-webhooks/components/IncomingWebhooksPage')
                    ).default,
                  }),
                },
                // T716: the audit log of the base (CONTRACTS §11.4).
                {
                  path: 'audit',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (await import('../features/audit/components/BaseAuditLogPage'))
                      .default,
                  }),
                },
              ],
            },
            {
              path: 'o/:orgSlug/settings/share-links',
              loader: guards.orgSettings,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/share/manage/components/OrgShareLinksPage'))
                  .default,
              }),
            },
            // Organization settings for owners/admins (FRONTEND §15): the layout with the
            // "Organization settings" nav (T526) and its pages. The guard is on the layout
            // so other members get the 404 screen without the nav.
            {
              path: 'o/:orgSlug/settings',
              loader: guards.orgSettings,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/org-settings/layout/OrgSettingsLayout'))
                  .default,
              }),
              children: [
                // T526: email settings of the organization (CONTRACTS §23.2, §23.4).
                {
                  path: 'email',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/org-settings/email/components/EmailSettingsPage')
                    ).default,
                  }),
                },
                // T533: sender identities of the organization (ADR-33).
                {
                  path: 'email/identities',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/org-settings/email-identities/components/EmailIdentitiesPage')
                    ).default,
                  }),
                },
                // T516: Telegram bots of the organization (`send_telegram`, CONTRACTS §24).
                {
                  path: 'telegram',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/org-settings/telegram-bots/components/TelegramBotsPage')
                    ).default,
                  }),
                },
                // T613: outbound HTTP allowlist and HTTP secrets (CONTRACTS §24, §25.4).
                {
                  path: 'integrations',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (
                      await import('../features/org-settings/integrations/components/IntegrationsPage')
                    ).default,
                  }),
                },
                // T716: the audit log of the organization (CONTRACTS §11.4).
                {
                  path: 'audit',
                  errorElement: <RouteErrorPanel />,
                  lazy: async () => ({
                    Component: (await import('../features/audit/components/OrgAuditLogPage'))
                      .default,
                  }),
                },
              ],
            },
            // T714: the caller's API tokens; owners/admins also all tokens and the policy.
            {
              path: 'o/:orgSlug/settings/api-tokens',
              loader: guards.org,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (
                  await import('../features/org-settings/api-tokens/components/ApiTokensPage')
                ).default,
              }),
            },
            // T524: the caller's notification settings in an organization (FRONTEND §14).
            {
              path: 'o/:orgSlug/settings/notifications',
              loader: guards.org,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (
                  await import('../features/notifications/settings/NotificationSettingsPage')
                ).default,
              }),
            },
            // Links of notification emails sent before T524 (and bookmarks): the current
            // (last used) organization's settings.
            {
              path: 'me/settings/notifications',
              lazy: async () => ({
                loader: (
                  await import('../features/notifications/settings/redirect')
                ).notificationSettingsRedirect(queryClient),
              }),
            },
            // T715: the caller's connected OIDC accounts (CONTRACTS §27.3).
            {
              path: 'account/connections',
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/account/connections/ConnectionsPage'))
                  .default,
              }),
            },
            // T520: the automations of a base (FRONTEND §13).
            {
              path: 'b/:baseId/automations',
              loader: guards.baseAutomations,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (
                  await import('../features/automation/list/components/AutomationListPage')
                ).default,
              }),
            },
            // T521: the builder of a new automation (created on save) and of an existing one.
            {
              path: 'b/:baseId/automations/new',
              loader: guards.baseAutomations,
              errorElement: <RouteErrorPanel />,
              lazy: loadAutomationBuilderRoute,
            },
            {
              path: 'b/:baseId/automations/:automationId',
              loader: guards.baseAutomations,
              errorElement: <RouteErrorPanel />,
              lazy: loadAutomationBuilderRoute,
            },
            // T523: the run history of an automation (its "Run history" tab) and of the base.
            ...['b/:baseId/automations/runs', 'b/:baseId/automations/:automationId/runs'].map(
              (path) => ({
                path,
                loader: guards.baseAutomations,
                errorElement: <RouteErrorPanel />,
                lazy: async () => ({
                  Component: (await import('../features/automation/runs/components/RunHistoryPage'))
                    .default,
                }),
              }),
            ),
            // T811 (S7): a dashboard, view mode. ECharts and react-grid-layout load with it only.
            // T812: `?edit=1` (base admins) loads the editor chunk and, from here, the filter builder.
            // T813: the record panel opens records of a click-through (lazy, as for the grid).
            {
              path: 'b/:baseId/d/:dashboardId',
              loader: guards.dashboard,
              errorElement: <RouteErrorPanel />,
              lazy: () =>
                import('./dashboard-route').then((module) =>
                  module.loadDashboardRoute(RECORD_DETAIL),
                ),
            },
            // T469 (S4b decision #4): the base trash (deleted tables), base admins only.
            {
              path: 'b/:baseId/trash',
              loader: guards.baseSettings,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/trash/components/BaseTrashPage')).default,
              }),
            },
            {
              path: 'b/:baseId/t/:tableId/trash',
              loader: guards.table,
              errorElement: <RouteErrorPanel />,
              lazy: async () => ({
                Component: (await import('../features/trash/components/TrashPage')).default,
              }),
            },
          ],
        },
        { path: '*', loader: guards.unknownPath, element: <NotFoundPage /> },
      ],
    },
  ];
}

export function createAppRouter(queryClient: QueryClient) {
  return createBrowserRouter(createRoutes(queryClient));
}
