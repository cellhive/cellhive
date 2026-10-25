/**
 * (T713) The role editor (`features/base-settings`) gets its record rule
 * editor — the view filter builder over a table's fields (`features/view`)
 * — from here (FRONTEND §1.2). Separate chunks, loaded when the editor
 * opens; this module is loaded by the router on demand (nothing of it in
 * the app shell).
 */
export async function loadRoleEditorRoute() {
  const [{ RoleEditorPage }, { RuleFilterEditor }] = await Promise.all([
    import('../features/base-settings/roles/editor/RoleEditorPage'),
    import('../features/view/toolbar/FilterBuilder'),
  ]);
  return {
    Component: function RoleEditorRoute() {
      return <RoleEditorPage RuleFilterEditor={RuleFilterEditor} />;
    },
  };
}
