export function isSelectableAccountId(accountId: string): boolean {
  return !accountId.endsWith("-configuration");
}

export function resolveSelectedAccountIds(
  selectableIds: readonly string[],
  selectedAccountIds: readonly string[] | undefined,
): string[] {
  const selectable = selectableIds.filter(isSelectableAccountId);
  if (!selectedAccountIds || selectedAccountIds.length === 0) {
    return [...selectable];
  }

  const allowed = new Set(selectable);
  return selectedAccountIds.filter((id) => allowed.has(id));
}

export function toggleSelectedAccountId(
  selectableIds: readonly string[],
  selectedAccountIds: readonly string[],
  accountId: string,
): string[] {
  const current = resolveSelectedAccountIds(selectableIds, selectedAccountIds);
  if (!selectableIds.includes(accountId) || !isSelectableAccountId(accountId)) {
    return current;
  }

  const selected = new Set(current);
  if (selected.has(accountId)) {
    selected.delete(accountId);
  } else {
    selected.add(accountId);
  }

  const next = selectableIds.filter((id) => selected.has(id));
  return next.length === 0 ? current : next;
}
