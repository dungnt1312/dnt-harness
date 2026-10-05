/**
 * Path grants for the file tools: which folders a tool run may touch and
 * how a requested path is classified against them.
 *
 * A run has a primary root (the bound project, read-write) plus optional
 * additional roots, each read-only or read-write. Every target resolves
 * against the primary first (`path.resolve(primary, target)`), then matches
 * the longest granted root that lexically contains it. Classification is
 * purely lexical — it never touches the filesystem — so it is safe to run
 * before an approval: a UNC path (`\\host\share`) must not open an SMB
 * session, and a device path must not be opened, before a human decides.
 * Symlink/junction containment is checked afterwards, at execution, against
 * the matched root.
 *
 * Still application-level containment, not an OS sandbox.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolCall } from '../../harness/llm/types.ts'
import type { ApprovedPath, GrantedRoot, PathIntent, ToolExecution } from '../../harness/tools/types.ts'

/** Case-normalizing containment check (Windows paths vary in case). Uses
 * `path.relative`, so drive roots (`C:\`) and UNC roots behave correctly. */
export function within(parent: string, child: string): boolean {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent
  const c = process.platform === 'win32' ? child.toLowerCase() : child
  const rel = path.relative(p, c)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** True when two absolute paths name the same location (case-folded on Windows). */
export function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Resolve `target` inside `root`, rejecting lexical escapes. */
export function resolveWithin(root: string, target: string): string {
  const absRoot = path.resolve(root)
  const abs = path.resolve(absRoot, target)
  if (!within(absRoot, abs)) {
    throw new Error(`path '${target}' escapes the workspace root`)
  }
  return abs
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return p
  }
}

/** The deepest ancestor of `abs` that exists (abs itself when it exists). */
async function deepestExisting(abs: string): Promise<string> {
  let probe = abs
  for (;;) {
    try {
      await fs.stat(probe)
      return probe
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return probe
      probe = parent
    }
  }
}

/** The real location of `abs`, following links in its existing portion. */
async function realTargetOf(abs: string): Promise<string> {
  const existing = await deepestExisting(abs)
  const realExisting = await realpathSafe(existing)
  return existing === abs ? realExisting : path.join(realExisting, path.relative(existing, abs))
}

async function assertNotDenied(target: string, abs: string, realTarget: string, deniedRoots?: readonly string[]): Promise<void> {
  if (deniedRoots === undefined) return
  for (const denied of deniedRoots) {
    const deniedReal = await realpathSafe(denied)
    if (within(denied, abs) || within(deniedReal, realTarget)) {
      throw new Error(`path '${target}' is inside application-internal storage and is not accessible to tools`)
    }
  }
}

/**
 * Resolve a granted path: lexical containment, then a realpath check that
 * follows symlinks/junctions in the existing portion of the path (including
 * the creation path — the parent a new file would land in), then refusal of
 * anything inside `deniedRoots` (application-internal storage).
 */
export async function resolveGrantedPath(
  root: string,
  target: string,
  deniedRoots?: readonly string[],
): Promise<string> {
  const abs = resolveWithin(root, target)
  const realTarget = await realTargetOf(abs)
  const rootReal = await realpathSafe(root)
  if (!within(rootReal, realTarget) || !within(root, abs)) {
    throw new Error(`path '${target}' escapes the workspace root`)
  }
  await assertNotDenied(target, abs, realTarget, deniedRoots)
  return abs
}

/** Windows device names that open devices instead of files, with or without an extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/**
 * Why a raw target must never be touched, or undefined. UNC and device
 * namespaces (`\\host\share`, `\\?\`, `\\.\pipe\x`) and reserved device
 * names are refused lexically: even a `stat` on a UNC path authenticates to
 * the remote host.
 */
export function blockedReason(target: string, abs: string): string | undefined {
  for (const candidate of [target, abs]) {
    if (candidate.startsWith('\\\\') || candidate.startsWith('//') || candidate.startsWith('\\/') || candidate.startsWith('/\\')) {
      return 'network (UNC) and device paths are not accessible to tools'
    }
  }
  if (process.platform === 'win32') {
    for (const segment of [...target.split(/[\\/]/), ...abs.split(/[\\/]/)]) {
      if (RESERVED_NAME.test(segment.trim())) return `'${segment}' is a reserved device name`
      // Win32 silently strips trailing dots and spaces, so `locked.\x` names
      // `locked\x` on disk while looking like a different folder lexically.
      if (segment !== '.' && segment !== '..' && /[. ]$/.test(segment)) {
        return `'${segment}' ends in a dot or space, which Windows would silently rewrite`
      }
    }
  }
  return undefined
}

/** How one requested path relates to the run's grants. */
export type PathClass =
  | { readonly kind: 'blocked'; readonly abs: string; readonly reason: string }
  | { readonly kind: 'denied'; readonly abs: string }
  | { readonly kind: 'read-only'; readonly abs: string; readonly root: GrantedRoot }
  | { readonly kind: 'in-grant'; readonly abs: string; readonly root: GrantedRoot }
  | { readonly kind: 'out-of-grant'; readonly abs: string }

/** Every root this run may use, primary first (always read-write). */
export function grantedRoots(exec: Pick<ToolExecution, 'root' | 'additionalRoots'>): GrantedRoot[] {
  return [{ path: path.resolve(exec.root), access: 'write' }, ...(exec.additionalRoots ?? [])]
}

/** The longest additional root containing an absolute path. */
export function classifyGrantedRoots(roots: readonly GrantedRoot[], abs: string): GrantedRoot | undefined {
  let match: GrantedRoot | undefined
  for (const root of roots) {
    if (!within(root.path, abs)) continue
    if (match === undefined || root.path.length > match.path.length) match = root
  }
  return match
}

/**
 * Classify `target` against the run's grants without touching the
 * filesystem. The longest containing root wins, so a read-only folder nested
 * in a read-write one stays read-only.
 */
export function classifyTarget(
  exec: Pick<ToolExecution, 'root' | 'additionalRoots' | 'deniedRoots'>,
  target: string,
  intent: PathIntent,
): PathClass {
  const abs = path.resolve(exec.root, target)
  const blocked = blockedReason(target, abs)
  if (blocked !== undefined) return { kind: 'blocked', abs, reason: blocked }
  if (exec.deniedRoots?.some((denied) => within(denied, abs)) === true) return { kind: 'denied', abs }
  const match = classifyGrantedRoots(grantedRoots(exec), abs)
  if (match === undefined) return { kind: 'out-of-grant', abs }
  if (intent === 'write' && match.access === 'read') return { kind: 'read-only', abs, root: match }
  return { kind: 'in-grant', abs, root: match }
}

/**
 * Re-classify the REAL location against the real grant folders: the lexical
 * match must still be the longest real match with the needed access. A short
 * name (`LOCKED~1`) or a link inside a read-write folder pointing into a
 * nested read-only one would otherwise write where the grant forbids it.
 */
async function assertSameGrantOnDisk(exec: ToolExecution, lexical: GrantedRoot, abs: string, target: string, intent: PathIntent): Promise<void> {
  const realTarget = await realTargetOf(abs)
  let match: { readonly root: GrantedRoot; readonly real: string } | undefined
  for (const root of grantedRoots(exec)) {
    const real = await realpathSafe(root.path)
    if (!within(real, realTarget)) continue
    if (match === undefined || real.length > match.real.length) match = { root, real }
  }
  if (match === undefined || !samePath(match.root.path, lexical.path)) {
    throw new Error(`path '${target}' resolves on disk into a different granted folder than it names; use the real path`)
  }
  if (intent === 'write' && match.root.access === 'read') {
    throw new Error(`path '${target}' is in a read-only granted folder (${match.root.path})`)
  }
}

/** A path outside every granted folder; approval-gated by the host. */
export class OutOfGrantError extends Error {
  constructor(
    readonly target: string,
    readonly abs: string,
    readonly intent: PathIntent,
  ) {
    super(`path '${target}' escapes the workspace root and every granted folder`)
    this.name = 'OutOfGrantError'
  }
}

function approvedFor(approved: readonly ApprovedPath[] | undefined, abs: string, intent: PathIntent): boolean {
  // A write approval covers reading the same path; a read approval never covers a write.
  return approved?.some((entry) => samePath(entry.path, abs) && (entry.intent === 'write' || intent === 'read')) === true
}

/**
 * Resolve a tool path against the run's grants, enforcing access and
 * link containment. Throws {@link OutOfGrantError} for a path outside every
 * granted folder unless an approval allowed exactly that path for this call.
 */
export async function resolveInGrants(exec: ToolExecution, target: string, intent: PathIntent): Promise<string> {
  const classified = classifyTarget(exec, target, intent)
  switch (classified.kind) {
    case 'blocked':
      throw new Error(`path '${target}' is refused: ${classified.reason}`)
    case 'denied':
      throw new Error(`path '${target}' is inside application-internal storage and is not accessible to tools`)
    case 'read-only':
      throw new Error(`path '${target}' is in a read-only granted folder (${classified.root.path})`)
    case 'in-grant': {
      const abs = await resolveGrantedPath(classified.root.path, classified.abs, exec.deniedRoots)
      await assertSameGrantOnDisk(exec, classified.root, abs, target, intent)
      return abs
    }
    case 'out-of-grant': {
      if (!approvedFor(exec.approvedPaths, classified.abs, intent)) {
        throw new OutOfGrantError(target, classified.abs, intent)
      }
      // The approver saw the lexical path. A link anywhere along it would
      // redirect the approved access somewhere else, so refuse instead.
      const realTarget = await realTargetOf(classified.abs)
      if (!samePath(realTarget, classified.abs)) {
        throw new Error(`path '${target}' resolves through a link to '${realTarget}'; approve the real path instead`)
      }
      await assertNotDenied(target, classified.abs, realTarget, exec.deniedRoots)
      return classified.abs
    }
  }
}

/** Display form for a tool result path: primary-relative inside the primary, absolute elsewhere. */
export function displayPath(primary: string, full: string): string {
  const absPrimary = path.resolve(primary)
  return within(absPrimary, full) ? path.relative(absPrimary, full).split(path.sep).join('/') : full
}

/** The file tools whose path arguments are subject to grants, with their intent. */
const PATH_ARGS: Readonly<Record<string, { readonly arg: string; readonly intent: PathIntent; readonly optional?: boolean }>> = {
  Read: { arg: 'path', intent: 'read' },
  Write: { arg: 'path', intent: 'write' },
  Edit: { arg: 'path', intent: 'write' },
  Glob: { arg: 'path', intent: 'read', optional: true },
  Grep: { arg: 'path', intent: 'read', optional: true },
}

/** One path a tool call targets, with the access it needs. */
export interface TargetPath {
  readonly target: string
  readonly intent: PathIntent
}

/**
 * The paths a file-tool call touches. Glob/Grep without `path` search the
 * primary root. Non-file tools and malformed arguments yield nothing (the
 * tool itself reports bad arguments).
 */
export function targetPaths(call: Pick<ToolCall, 'name' | 'args'>): TargetPath[] {
  const spec = PATH_ARGS[call.name]
  if (spec === undefined) return []
  const value = (call.args as Record<string, unknown>)[spec.arg]
  if (typeof value !== 'string' || value === '') return spec.optional === true ? [{ target: '.', intent: spec.intent }] : []
  return [{ target: value, intent: spec.intent }]
}
