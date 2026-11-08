import type { AutomationConditionEditorProps } from '../lib/automation/condition-editor';
import type { ConditionKit } from '../lib/automation/condition-kit';

/**
 * (T521) The automation builder (`features/automation`) gets the model and
 * value editors of the view filter builder (`features/view`) for its
 * conditions — (T1012) the condition branch builder of Lucian UX/UI #132,
 * `features/automation/builder/components/conditions` — and (T612) the
 * incoming webhook dialogs (`features/integrations`) from here (FRONTEND
 * §1.2). Separate chunks, loaded when the builder opens; this module is
 * loaded by the router on demand (nothing of it in the app shell).
 */
export async function loadAutomationBuilderRoute() {
  const [
    { AutomationBuilderPage },
    { ConditionBranchBuilder },
    filterModel,
    { ValueEditor },
    { webhookKit },
  ] = await Promise.all([
    import('../features/automation/builder/components/AutomationBuilderPage'),
    import('../features/automation/builder/components/conditions/ConditionBranchBuilder'),
    import('../features/view/toolbar/filter-model'),
    import('../features/view/toolbar/ValueEditor'),
    import('../features/integrations/incoming-webhooks/kit'),
  ]);
  const kit: ConditionKit = { model: filterModel, ValueEditor };
  // One component for the life of the route: the builder keys its editors, never remounts them.
  function ConditionEditor(props: AutomationConditionEditorProps) {
    return <ConditionBranchBuilder {...props} kit={kit} />;
  }
  return {
    Component: function AutomationBuilderRoute() {
      return <AutomationBuilderPage ConditionEditor={ConditionEditor} webhookKit={webhookKit} />;
    },
  };
}
