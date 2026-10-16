const STORAGE_PREFIX = 'dnt-harness.sidebar-collapsed.'
const EXPANDED_PREFIX = 'dnt-harness.sidebar-expanded.'

/** Restore the collapsed sidebar folders for one workspace. Invalid storage is ignored. */
export function loadCollapsedFolders(workspaceId: string): Record<string, boolean> {
  return filterEntries(loadStored(`${STORAGE_PREFIX}${workspaceId}`), (entry): entry is [string, true] => entry[1] === true)
}

/** Persist only collapsed folders; omitted entries use the default open state. */
export function storeCollapsedFolders(workspaceId: string, folders: Readonly<Record<string, boolean>>): void {
  storeStored(`${STORAGE_PREFIX}${workspaceId}`, filterEntries(folders, (entry): entry is [string, true] => entry[1] === true))
}

/** Restore per-folder "Show more" paging (extra rows past the preview) for one workspace. */
export function loadExpandedFolders(workspaceId: string): Record<string, number> {
  return filterEntries(loadStored(`${EXPANDED_PREFIX}${workspaceId}`), (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
}

/** Persist per-folder "Show more" paging; a 0 value is kept so a restored "Less" state survives. */
export function storeExpandedFolders(workspaceId: string, folders: Readonly<Record<string, number>>): void {
  storeStored(`${EXPANDED_PREFIX}${workspaceId}`, filterEntries(folders, (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
}

function loadStored(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? '{}')
  } catch {
    return {}
  }
}

function storeStored(key: string, entries: Readonly<Record<string, unknown>>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(entries))
  } catch { /* storage may be unavailable */ }
}

function filterEntries<T>(value: unknown, guard: (entry: [string, unknown]) => entry is [string, T]): Record<string, T> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry) => guard(entry as [string, unknown])))
}
