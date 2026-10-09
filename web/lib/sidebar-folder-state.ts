const STORAGE_PREFIX = 'dnt-harness.sidebar-collapsed.'

/** Restore the collapsed sidebar folders for one workspace. Invalid storage is ignored. */
export function loadCollapsedFolders(workspaceId: string): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`${STORAGE_PREFIX}${workspaceId}`) ?? '{}')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, true] => entry[1] === true))
  } catch {
    return {}
  }
}

/** Persist only collapsed folders; omitted entries use the default open state. */
export function storeCollapsedFolders(workspaceId: string, folders: Readonly<Record<string, boolean>>): void {
  try {
    const collapsed = Object.fromEntries(Object.entries(folders).filter((entry): entry is [string, true] => entry[1] === true))
    window.localStorage.setItem(`${STORAGE_PREFIX}${workspaceId}`, JSON.stringify(collapsed))
  } catch { /* storage may be unavailable */ }
}
