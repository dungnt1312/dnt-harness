/** Compare JSON listing payloads without treating a fresh network array as a change. */
export function sameListing<T extends object>(previous: readonly T[], next: readonly T[]): boolean {
  return previous.length === next.length && previous.every((row, index) => {
    const candidate = next[index]
    if (candidate === undefined) return false
    const keys = Object.keys(row)
    const left = row as Record<string, unknown>
    const right = candidate as Record<string, unknown>
    return keys.length === Object.keys(candidate).length && keys.every((key) => Object.is(left[key], right[key]))
  })
}
