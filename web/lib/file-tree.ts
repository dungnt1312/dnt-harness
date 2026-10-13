/**
 * Pure path helpers for the workbench explorer. Paths are root-relative with
 * `/` separators; '' is the project root.
 */

/** The explorer row the user last clicked. */
export interface Selection {
  readonly path: string
  readonly kind: 'file' | 'dir'
}

/** `path` is `target` itself or lies inside the folder `target`. */
export const isAtOrUnder = (path: string, target: string): boolean => path === target || path.startsWith(`${target}/`)

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export function joinPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/** Every folder from the top down to `folder` itself; [] for the root. */
export function ancestorsOf(folder: string): string[] {
  if (folder === '') return []
  const segments = folder.split('/')
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

/** Where "New file" and "New folder" land: a selected folder, a selected file's folder, else the root. */
export function targetFolder(selected: Selection | null): string {
  if (selected === null) return ''
  return selected.kind === 'dir' ? selected.path : parentOf(selected.path)
}

/** The record without keys at or under `path`; the same object when none matched. */
export function dropKeysUnder<T>(record: Readonly<Record<string, T>>, path: string): Readonly<Record<string, T>> {
  const kept = Object.entries(record).filter(([key]) => !isAtOrUnder(key, path))
  return kept.length === Object.keys(record).length ? record : Object.fromEntries(kept)
}

/** The set without members at or under `path`; the same set when none matched. */
export function dropUnderSet(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const kept = [...set].filter((member) => !isAtOrUnder(member, path))
  return kept.length === set.size ? set : new Set(kept)
}

/**
 * The message to show for a failed explorer write. An `HttpError` carries
 * the server's `{"error": "…"}` body; it is read structurally so callers that
 * mock `api.ts` still work.
 */
export function writeErrorText(error: unknown): string {
  const body = typeof error === 'object' && error !== null ? (error as { body?: unknown }).body : undefined
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') {
        return (parsed as { error: string }).error
      }
    } catch {
      // Not JSON: show the body as it came.
    }
    if (body !== '') return body
  }
  return error instanceof Error ? error.message : String(error)
}
