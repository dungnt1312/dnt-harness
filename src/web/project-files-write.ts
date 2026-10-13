import { promises as fs } from 'node:fs'
import path from 'node:path'
import { blockedReason, resolveGrantedPath, within } from '../capabilities/fs/grants.ts'
import { canonical, replaceFile, withFileLock } from '../capabilities/fs/observation.ts'
import { BinaryFileError, decodeDocument, encodeForWrite, hashBytes } from '../capabilities/fs/text-document.ts'
import { MAX_FILE_BYTES, type ProjectEntry } from './project-files.ts'

/**
 * Explorer writes for the web workbench: create a file or folder, rename in
 * place, delete. Only the parent folder is resolved through the granted-path
 * rules; the last segment is then handled with `lstat`, so a link there is
 * renamed or removed itself and never followed. The project root and `.git`
 * are never touched. Check-then-act leaves a small race window: this is
 * application-level containment, not an OS sandbox.
 */

export class ProjectWriteError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, message: string, readonly currentHash?: string) {
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
  if (isGitName(name)) return "'.git' is protected"
  return blockedReason(name, name)
}

/** `.git` in any letter case, so `.GIT` cannot reach it on a case-insensitive volume. */
function isGitName(segment: string): boolean {
  return segment.normalize('NFC').toLowerCase() === '.git'
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

/**
 * Like `normalizeRelative` but without trimming: an existing entry may be named
 * with leading or trailing whitespace. Names being created are checked by
 * `nameProblem`; a blank path still counts as the project root.
 */
function normalizeExisting(raw: string): string {
  if (raw.trim() === '') return ''
  const rel = raw.replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
  return rel === '.' ? '' : rel
}

/** Letter case and Unicode form are not significant on macOS and Windows volumes. */
function fold(p: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? p.normalize('NFC').toLowerCase() : p
}

const withinFolded = (parent: string, child: string): boolean => within(fold(parent), fold(child))

interface Protection {
  /** `abs` is a protected root or lies inside one. */
  readonly inside: boolean
  /** `abs` is an ancestor of a protected root. */
  readonly contains: boolean
}

/**
 * Whether `abs` is protected storage: compared with case and normalization
 * folded, and — when `abs` exists — by file identity, so a spelling the volume
 * accepts but the lexical comparison misses (`.SSH`, `library`) is still caught.
 */
async function protection(root: string, abs: string, deniedRoots: readonly string[] | undefined): Promise<Protection> {
  let inside = false
  let contains = false
  if (deniedRoots === undefined || deniedRoots.length === 0) return { inside, contains }
  const stat = await fs.lstat(abs).catch(() => null)
  const rootReal = await fs.realpath(root).catch(() => root)
  const inProject = (p: string): boolean => withinFolded(root, p) || withinFolded(rootReal, p)
  const atRoot = (p: string): boolean => fold(path.resolve(p)) === fold(path.resolve(root)) || fold(path.resolve(p)) === fold(path.resolve(rootReal))
  for (const denied of deniedRoots) {
    const deniedReal = await fs.realpath(denied).catch(() => denied)
    for (const d of [denied, deniedReal]) {
      if (withinFolded(d, abs)) inside = true
      if (withinFolded(abs, d)) contains = true
    }
    if (stat === null) continue
    // Walk from the denied root (or its nearest existing ancestor) up to the project root.
    let cur = deniedReal
    while (!(await fs.lstat(cur).then(() => true, () => false))) {
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    const isDenied = cur === deniedReal
    for (let depth = 0; inProject(cur) && !atRoot(cur); depth += 1) {
      const s = await fs.lstat(cur).catch(() => null)
      if (s !== null && s.dev === stat.dev && s.ino === stat.ino) {
        if (depth === 0 && isDenied) inside = true
        else contains = true
      }
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  }
  return { inside, contains }
}

async function target(root: string, raw: string, deniedRoots: readonly string[] | undefined): Promise<Target> {
  const rel = normalizeExisting(raw)
  if (path.isAbsolute(raw.trim()) || /^[a-zA-Z]:/.test(rel)) refuse('path must be relative to the project root')
  if (rel === '') refuse('the project root itself cannot be changed')
  const segments = rel.split('/')
  if (segments.includes('..')) refuse(`path '${rel}' escapes the project root`)
  if (segments.includes('.')) refuse(`path '${rel}' must not contain '.' segments`)
  if (segments.some(isGitName)) refuse("'.git' is protected")
  const name = segments[segments.length - 1] as string
  const parentRel = segments.slice(0, -1).join('/')
  let parentAbs: string
  try {
    parentAbs = await resolveGrantedPath(root, parentRel === '' ? '.' : parentRel, deniedRoots)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  const abs = path.join(parentAbs, name)
  if (path.resolve(abs) === path.resolve(root)) refuse('the project root itself cannot be changed')
  if ((await protection(root, abs, deniedRoots)).inside) refuse(`path '${rel}' is inside protected storage`)
  return { rel, parentAbs, parentRel, name, abs }
}

/** Refuse removing or moving `abs` when a protected root lies at or under it. */
async function refuseProtectedDescendant(root: string, abs: string, rel: string, deniedRoots: readonly string[] | undefined): Promise<void> {
  const p = await protection(root, abs, deniedRoots)
  if (p.inside) refuse(`path '${rel}' is inside protected storage`)
  if (p.contains) refuse(`path '${rel}' contains protected storage`)
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
  await refuseProtectedDescendant(root, t.abs, t.rel, deniedRoots)
  const source = await fs.lstat(t.abs).catch(() => null)
  if (source === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  const destAbs = path.join(t.parentAbs, newName)
  if ((await protection(root, destAbs, deniedRoots)).inside) refuse(`'${newName}' is inside protected storage`)
  const existing = await fs.lstat(destAbs).catch(() => null)
  // The same inode is fine only for a case or normalization rename of one entry;
  // a hard link of the file would turn the POSIX rename into a silent no-op.
  const sameEntry = existing !== null && existing.ino === source.ino && existing.dev === source.dev && fold(newName) === fold(t.name)
  if (existing !== null && !sameEntry) {
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
  await refuseProtectedDescendant(root, t.abs, t.rel, deniedRoots)
  const source = await fs.lstat(t.abs).catch(() => null)
  if (source === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  // `rm` removes a link itself and never descends into its target.
  await fs.rm(t.abs, { recursive: source.isDirectory(), force: false })
  return { path: t.rel }
}

/**
 * Save the viewer's edited text over an existing project file. Refuses when
 * the stored bytes no longer hash to `expectedHash` (409, with the current
 * hash), so a change the agent or another tab made is never overwritten
 * silently. Keeps the file's encoding, BOM and dominant line ending, writes
 * atomically, and serialises with the agent's file tools on the same lock.
 */
export async function saveProjectFile(
  root: string,
  rawPath: string,
  content: string,
  expectedHash: string,
  deniedRoots?: readonly string[],
): Promise<{ path: string; size: number; hash: string }> {
  const t = await target(root, rawPath, deniedRoots)
  let resolved: string
  try {
    resolved = await resolveGrantedPath(root, t.rel, deniedRoots)
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error))
  }
  const stat = await fs.stat(resolved).catch(() => null)
  if (stat === null) throw new ProjectWriteError(404, `'${t.rel}' does not exist`)
  if (!stat.isFile()) refuse(`'${t.rel}' is not a file`)
  const file = await canonical(resolved)
  // A link inside the project may point into `.git` or protected storage.
  const rootReal = await fs.realpath(root).catch(() => root)
  const relReal = path.relative(rootReal, file).split(path.sep)
  if (relReal.some(isGitName)) refuse("'.git' is protected")
  if ((await protection(root, file, deniedRoots)).inside) refuse(`path '${t.rel}' is inside protected storage`)
  return withFileLock(file, undefined, async () => {
    const bytes = await fs.readFile(file)
    const current = hashBytes(bytes)
    if (current !== expectedHash) {
      throw new ProjectWriteError(409, `'${t.rel}' changed on disk since it was opened`, current)
    }
    let doc
    try {
      doc = decodeDocument(bytes, t.rel)
    } catch (error) {
      if (error instanceof BinaryFileError) refuse(`'${t.rel}' is a binary file`)
      throw error
    }
    if (!doc.writable || doc.encoding !== 'utf8') refuse(`'${t.rel}' is not UTF-8 text and cannot be edited here`)
    // The read path hands the BOM back as a leading U+FEFF; encodeForWrite adds it again.
    const text = doc.bom && content.startsWith('\uFEFF') ? content.slice(1) : content
    const next = encodeForWrite(text, doc)
    if (next.length > MAX_FILE_BYTES) {
      throw new ProjectWriteError(413, `'${t.rel}' would be larger than ${MAX_FILE_BYTES / (1024 * 1024)} MiB`)
    }
    await replaceFile(file, next)
    return { path: t.rel, size: next.length, hash: hashBytes(next) }
  })
}
