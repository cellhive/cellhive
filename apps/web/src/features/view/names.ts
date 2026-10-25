/**
 * A view name not used in its group yet (view names are unique per group,
 * case-insensitively, CONTRACTS §15): `base`, else `base 2`, `base 3`…
 */
export function uniqueViewName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${String(suffix)}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

/** The view to open when `viewId` goes away: the first remaining shared view, else any. */
export function fallbackViewId(
  views: readonly { readonly id: string; readonly is_personal: boolean }[],
  viewId: string,
): string | undefined {
  const rest = views.filter((view) => view.id !== viewId);
  return (rest.find((view) => !view.is_personal) ?? rest[0])?.id;
}
