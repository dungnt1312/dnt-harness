import type { FileFocus } from './tool-facts.ts'

/**
 * Returns an opener when a recorded path resolves inside the project, else
 * null. `focus` is the window the call named, so the viewer can land on the
 * lines the call actually read instead of the top of the file.
 */
export type OpenPathResolver = (reference: string, focus?: FileFocus) => (() => void) | null

/**
 * Map a path recorded in a tool call to a project-relative workbench path.
 * Absolute paths must sit inside the project root (case-insensitive on
 * Windows-style roots); relative paths are taken as root-relative. Anything
 * escaping the root returns null so the UI never offers to open it.
 */
export function toProjectRelative(root: string, target: string): string | null {
  const normalize = (value: string): string => value.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  const base = normalize(root)
  const candidate = normalize(target)
  if (candidate === '') return null
  const absolute = /^[a-zA-Z]:\//.test(candidate) || candidate.startsWith('/')
  let relative: string
  if (absolute) {
    const windows = /^[a-zA-Z]:\//.test(base)
    const inside = windows ? candidate.toLowerCase().startsWith(`${base.toLowerCase()}/`) : candidate.startsWith(`${base}/`)
    if (!inside) return null
    relative = candidate.slice(base.length + 1)
  } else {
    relative = candidate.replace(/^\.\//, '')
  }
  const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return segments.join('/')
}

/** A file a chat link points at, with the line window it named. */
export interface FileHref {
  readonly path: string
  readonly focus?: FileFocus
}

/**
 * Read a Markdown link target as a file reference. Web and mail links
 * (`https://…`, `mailto:`) and in-page anchors (`#x`) return null so the
 * browser handles them; everything else — `src/a.ts`, `/abs/a.ts`,
 * `file:///abs/a.ts`, with an optional `:12`, `:12:3`, `#L12` or `#L12-L20`
 * line suffix — is a path the workbench can open.
 */
export function parseFileHref(href: string | undefined): FileHref | null {
  if (href === undefined) return null
  let value = href.trim()
  if (value === '' || value.startsWith('#')) return null
  const fileScheme = /^file:\/\//i.test(value)
  // Any other `scheme:` is not a path — except a drive letter (`C:/x`) and a
  // bare name with a line suffix (`Makefile:3`, `a.ts:12`).
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)
  if (/^(javascript|vbscript|data):/i.test(value)) return null
  if (!fileScheme && scheme !== null && !/^[a-z]:[\\/]/i.test(value) && !/^[^:]+:\d+(?::\d+)?$/.test(value)) return null
  if (fileScheme) value = value.replace(/^file:\/\/(localhost)?/i, '')
  try {
    value = decodeURI(value)
  } catch {
    // Keep the raw text: a stray `%` in a path is not an encoding.
  }
  let focus: FileFocus | undefined
  const hashLine = /#L(\d+)(?:-L?(\d+))?$/.exec(value)
  const colonLine = hashLine === null ? /:(\d+)(?::\d+)?$/.exec(value) : null
  const match = hashLine ?? colonLine
  if (match !== null) {
    const line = Number(match[1])
    const end = hashLine !== null && match[2] !== undefined ? Number(match[2]) : undefined
    if (line > 0) focus = end !== undefined && end >= line ? { line, lines: end - line + 1 } : { line }
    value = value.slice(0, match.index)
  }
  value = value.replace(/[?#].*$/, '')
  return value === '' ? null : { path: value, ...(focus !== undefined ? { focus } : {}) }
}

const SKILL_TAB_PREFIX = 'skill://'

/**
 * The workbench path of a skill's SKILL.md. A skill can live outside the
 * project (user, workspace and bundled layers), so it is a virtual tab the
 * viewer reads through the skill API rather than a project-relative file.
 */
export function skillTabPath(name: string): string {
  return `${SKILL_TAB_PREFIX}${name}`
}

/** The skill a virtual tab path names, or null for an ordinary project file. */
export function skillTabName(path: string): string | null {
  if (!path.startsWith(SKILL_TAB_PREFIX)) return null
  const name = path.slice(SKILL_TAB_PREFIX.length)
  return name === '' ? null : name
}

const MEMORY_TAB_PREFIX = 'memory://'

/** A memory file a workbench tab names: the project tier when `projectId` is set, else the workspace tier. */
export interface MemoryTab {
  readonly projectId?: string
  /** Path inside the tier's memory folder, `/`-separated (e.g. `MEMORY.md`). */
  readonly file: string
}

/**
 * The workbench path of a memory file. Memory lives under the host's data
 * folder, outside every project, so like a skill it is a virtual tab the
 * viewer reads through the memory API.
 */
export function memoryTabPath(tab: MemoryTab): string {
  return `${MEMORY_TAB_PREFIX}${tab.projectId !== undefined ? `projects/${tab.projectId}` : 'workspace'}/${tab.file}`
}

/** The memory file a virtual tab path names, or null for anything else. */
export function memoryTabOf(path: string): MemoryTab | null {
  if (!path.startsWith(MEMORY_TAB_PREFIX)) return null
  const match = /^(?:workspace|projects\/([^/]+))\/(.+)$/.exec(path.slice(MEMORY_TAB_PREFIX.length))
  if (match === null) return null
  return { ...(match[1] !== undefined ? { projectId: match[1] } : {}), file: match[2] ?? '' }
}

/**
 * Read a path a tool recorded as a file in this workspace's memory folders
 * (`…/workspaces/<ws>/memory/workspace/…` or `…/memory/projects/<id>/…`).
 * Another workspace's memory, and any `..` escape, return null.
 */
export function memoryTabForReference(reference: string, workspaceId: string): string | null {
  const match = /(?:^|\/)workspaces\/([^/]+)\/memory\/(?:workspace|projects\/([^/]+))\/(.+)$/.exec(reference.trim().replaceAll('\\', '/'))
  if (match === null || match[1] !== workspaceId) return null
  const file = (match[3] ?? '').split('/').filter((segment) => segment !== '' && segment !== '.')
  if (file.length === 0 || file.includes('..')) return null
  return memoryTabPath({ ...(match[2] !== undefined ? { projectId: match[2] } : {}), file: file.join('/') })
}

const TURN_TAB_PREFIX = 'turn://'

/**
 * The workbench tab of one turn's recorded changes. A turn's diff comes from
 * the log, not from git or the project folder, so it is a virtual tab.
 */
export function turnTabPath(turnId: string): string {
  return `${TURN_TAB_PREFIX}${turnId}`
}

/** The turn a virtual tab path names, or null for anything else. */
export function turnTabId(path: string | null): string | null {
  if (path === null || !path.startsWith(TURN_TAB_PREFIX)) return null
  const id = path.slice(TURN_TAB_PREFIX.length)
  return id === '' ? null : id
}

/** Last path segment, used for tab titles (a skill tab is titled by the skill). */
export function baseName(path: string): string {
  const memory = memoryTabOf(path)
  return skillTabName(path) ?? (memory !== null ? memory.file : path).split('/').at(-1) ?? path
}
