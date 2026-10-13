import { promises as fs } from 'node:fs'
import path from 'node:path'
import { blockedReason, resolveGrantedPath, within } from '../capabilities/fs/grants.ts'
import { normalizeRelative, type ProjectEntry } from './project-files.ts'

/**
 * Explorer writes for the web workbench: create a file or folder, rename in
 * place, delete. Only the parent folder is resolved through the granted-path
 * rules; the last segment is then handled with `lstat`, so a link there is
 * renamed or removed itself and never followed. The project root and `.git`
 * are never touched. Check-then-act leaves a small race window: this is
 * application-level containment, not an OS sandbox.
 */

export class ProjectWriteError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message)
    this.name = 'ProjectWriteError'
  }
}

const MAX_NAME_BYTES = 255

/** Why `name` cannot be one path segment, or undefined when it can. */
function nameProblem(name: string): string | undefined {
  if (name === '') return 'name must not be empty'
  if (name === '.' || name === '..') return `'${name}' is not a valid name`
  if (/[/\\\0]/.test(name)) return 'name must not contain /, \\ or NUL'
  if (name !== name.trim()) return 'name must not start or end with whitespace'
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return `name must be at most ${MAX_NAME_BYTES} bytes`
  if (name === '.git') return "'.git' is protected"
  return blockedReason(name, name)
}

interface Target {
  /** Root-relative path with `/` separators. */
  readonly rel: string
  /** The resolved parent folder. */
  readonly parentAbs: string
  readonly parentRel: string
  readonly name: string
  /** `parentAbs` joined with `name`; never resolved through a link. */
  readonly abs: string
}

function refuse(message: string): never {
  throw new ProjectWriteError(400, message)
}

async function target(root: string, raw: string, deniedRoots: readonly string[] | undefined): Promise<Target> {
  // The normalizer trims; refuse instead so a name is never silently changed.
  if (raw !== raw.trim()) refuse('path must not start or end with whitespace')
  const rel = normalizeRelative(raw)
  if (path.isAbsolute(raw.trim()) || /^[a-zA-Z]:/.test(rel)) refuse('path must be relative to the project root')
  if (rel === '') refuse('the project root itself cannot be changed')
  const segments = rel.split('/')
  if (segments.includes('..')) refuse(`path '${rel}' escapes the project root`)
  if (segments.includes('.git')) refuse("'.git' is protected")
  const name = segments[segments.length - 1] as string
  const parentRel = segments.slice(0, -1).join('/')
  let parentAbs: string
  try {
    parentAbs = await resolveGrantedPath(root, parentRel === '' ? '.' : parentRel, deniedRoots)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  const abs = path.join(parentAbs, name)
  for (const denied of deniedRoots ?? []) {
    if (within(denied, abs)) refuse(`path '${rel}' is inside protected storage`)
  }
  return { rel, parentAbs, parentRel, name, abs }
}

async function requireFolder(abs: string, rel: string): Promise<void> {
  const stat = await fs.stat(abs).catch(() => null)
  if (stat === null) throw new ProjectWriteError(404, `folder '${rel || '.'}' does not exist`)
  if (!stat.isDirectory()) refuse(`'${rel}' is not a folder`)
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined

export async function createProjectEntry(root: string, rawPath: string, kind: 'file' | 'dir', deniedRoots?: readonly string[]): Promise<ProjectEntry> {
  const t = await target(root, rawPath, deniedRoots)
  const problem = nameProblem(t.name)
  if (problem !== undefined) refuse(problem)
  await requireFolder(t.parentAbs, t.parentRel)
  try {
    if (kind === 'file') await fs.writeFile(t.abs, '', { flag: 'wx' })
    else await fs.mkdir(t.abs)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') throw new ProjectWriteError(409, `'${t.rel}' already exists`)
    if (codeOf(error) === 'ENOENT') throw new ProjectWriteError(404, `folder '${t.parentRel || '.'}' does not exist`)
    throw error
  }
  return kind === 'file' ? { name: t.name, path: t.rel, kind: 'file', size: 0 } : { name: t.name, path: t.rel, kind: 'dir' }
}

export async function renameProjectEntry(root: string, rawPath: string, newName: string, deniedRoots?: readonly string[]): Promise<{ path: string; kind: 'file' | 'dir' }> {
  const t = await target(root, rawPath, deniedRoots)
  const problem = nameProblem(newName)
  if (problem !== undefined) refuse(problem)
  if (newName === t.name) refuse('the new name is the same as the current one')
  const source = await fs.lstat(t.abs).catch(() => null)
  if (source === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  const destAbs = path.join(t.parentAbs, newName)
  for (const denied of deniedRoots ?? []) {
    if (within(denied, destAbs)) refuse(`'${newName}' is inside protected storage`)
  }
  const existing = await fs.lstat(destAbs).catch(() => null)
  // Same inode means a case-only rename on a case-insensitive volume.
  if (existing !== null && !(existing.ino === source.ino && existing.dev === source.dev)) {
    throw new ProjectWriteError(409, `'${newName}' already exists`)
  }
  await fs.rename(t.abs, destAbs)
  const destRel = t.parentRel === '' ? newName : `${t.parentRel}/${newName}`
  // A link reports the kind of what it points to; a broken one counts as a file.
  const kind = source.isDirectory() || (source.isSymbolicLink() && (await fs.stat(destAbs).then((s) => s.isDirectory(), () => false))) ? 'dir' : 'file'
  return { path: destRel, kind }
}

export async function deleteProjectEntry(root: string, rawPath: string, deniedRoots?: readonly string[]): Promise<{ path: string }> {
  const t = await target(root, rawPath, deniedRoots)
  const source = await fs.lstat(t.abs).catch(() => null)
  if (source === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  // `rm` removes a link itself and never descends into its target.
  await fs.rm(t.abs, { recursive: source.isDirectory(), force: false })
  return { path: t.rel }
}
