/**
 * (T521) The automation builder (`features/automation`) gets its conditions
 * editor — the view filter builder in automation mode (`features/view`) —
 * and (T612) the incoming webhook dialogs (`features/integrations`) from here
 * (FRONTEND §1.2). Separate chunks, loaded when the builder opens; this
 * module is loaded by the router on demand (nothing of it in the app shell).
 */
export async function loadAutomationBuilderRoute() {
  const [{ AutomationBuilderPage }, { AutomationConditionEditor }, { webhookKit }] =
    await Promise.all([
      import('../features/automation/builder/components/AutomationBuilderPage'),
      import('../features/view/toolbar/AutomationConditionEditor'),
      import('../features/integrations/incoming-webhooks/kit'),
    ]);
  return {
    Component: function AutomationBuilderRoute() {
      return (
        <AutomationBuilderPage
          ConditionEditor={AutomationConditionEditor}
          webhookKit={webhookKit}
        />
      );
    },
  };
}
