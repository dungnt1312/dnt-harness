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

/** The absolute path of an entry under this project root. */
export function absoluteEntryPath(projectRoot: string, entryPath: string): string {
  const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot
  return entryPath === '' ? root : `${root}/${entryPath}`
}

/**
 * The drag type explorer rows write so the composer can turn a dropped row
 * back into a project reference. A private MIME-like name: another app's
 * payload can never be mistaken for one of ours.
 */
export const PROJECT_FILE_DRAG_TYPE = 'application/x-dnt-project-file'

/** The subset of `DataTransfer` the drag helpers read and write. */
export interface DragStore {
  setData(type: string, value: string): void
  getData(type: string): string
}

/** Write a row's drag payload: the typed reference plus a plain relative path, so dropping outside the composer still pastes a usable path. */
export function writeProjectFileDrag(store: DragStore, entry: Selection): void {
  store.setData(PROJECT_FILE_DRAG_TYPE, JSON.stringify({ path: entry.path, kind: entry.kind }))
  store.setData('text/plain', entry.path)
}

/** Read a dragged project reference back; anything but the exact shape is not ours. */
export function readProjectFileDrag(store: Pick<DragStore, 'getData'>): Selection | null {
  const raw = store.getData(PROJECT_FILE_DRAG_TYPE)
  if (raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { path, kind } = parsed as { path?: unknown; kind?: unknown }
    if (typeof path !== 'string' || path === '' || (kind !== 'file' && kind !== 'dir')) return null
    return { path, kind }
  } catch {
    return null
  }
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
