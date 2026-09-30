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

/** Last path segment, used for tab titles. */
export function baseName(path: string): string {
  return path.split('/').at(-1) ?? path
}
