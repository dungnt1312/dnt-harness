/**
 * The app was renamed from mini-dsh. Browser state (drafts, theme, workbench
 * tabs, project scope) was stored under `mini-dsh.*` keys; copy each one to
 * its `dnt-harness.*` name once, before anything reads storage, so nothing
 * the user had is lost. An existing new key always wins. Old keys are left
 * in place: deleting them buys nothing and would break a downgrade.
 */
export const LEGACY_PREFIX = 'mini-dsh.'
export const CURRENT_PREFIX = 'dnt-harness.'

export function migrateLegacyStorage(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>): number {
  let copied = 0
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key !== null && key.startsWith(LEGACY_PREFIX)) keys.push(key)
  }
  for (const key of keys) {
    const renamed = `${CURRENT_PREFIX}${key.slice(LEGACY_PREFIX.length)}`
    if (storage.getItem(renamed) !== null) continue
    const value = storage.getItem(key)
    if (value === null) continue
    storage.setItem(renamed, value)
    copied += 1
  }
  return copied
}
