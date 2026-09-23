/**
 * Host policy for extra file-tool folders ("grants"): which folders may be
 * granted at all, and how a session's effective grants are assembled from
 * its project's `additionalDirectories` and its own `session/grants` log.
 *
 * Every grant source — project settings, the session composer, and an
 * approval's "allow this folder for the session" — goes through
 * {@link validateGrantFolder}, so no path can be granted by one door that
 * another door would refuse.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { blockedReason, samePath, within } from '../capabilities/fs/grants.ts'
import type { SessionGrant } from '../harness/session/events.ts'
import type { GrantedRoot } from '../harness/tools/types.ts'
import type { ProjectRecord } from '../harness/workspace/types.ts'
import { ScopeError } from '../harness/workspace/types.ts'
import type { ProjectId } from '../util/brand.ts'

/** Folders a grant must neither contain nor sit inside (app storage, user skills). */
export interface GrantPolicy {
  readonly protectedRoots: readonly string[]
  /** Override for tests; defaults to the OS home directory. */
  readonly home?: string
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a)
}

/**
 * Validate one folder for granting and return its real path. Refuses
 * relative, UNC/device, missing, and non-directory paths, volume roots, the
 * home directory itself, anything overlapping protected app folders, and
 * anything overlapping the session's primary root (a grant nested in the
 * primary would let a relative path bypass its access level).
 */
export async function validateGrantFolder(raw: unknown, primary: string | undefined, policy: GrantPolicy): Promise<string> {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ScopeError('root-invalid', 'a folder path is required')
  if (!path.isAbsolute(raw)) throw new ScopeError('root-invalid', `'${raw}' is not an absolute path`)
  const resolved = path.resolve(raw)
  const blocked = blockedReason(raw, resolved)
  if (blocked !== undefined) throw new ScopeError('root-invalid', blocked)
  let real: string
  try {
    if (!(await fs.stat(resolved)).isDirectory()) throw new ScopeError('root-invalid', `'${raw}' is not a directory`)
    real = await fs.realpath(resolved)
  } catch (error) {
    if (error instanceof ScopeError) throw error
    throw new ScopeError('root-invalid', `no such directory '${raw}'`)
  }
  if (path.parse(real).root === real || path.parse(resolved).root === resolved) {
    throw new ScopeError('root-invalid', 'a whole drive cannot be granted')
  }
  if (samePath(real, policy.home ?? homedir())) {
    throw new ScopeError('root-invalid', 'the home folder itself cannot be granted; choose a folder inside it')
  }
  for (const guarded of policy.protectedRoots) {
    if (overlaps(real, guarded) || overlaps(resolved, guarded)) {
      throw new ScopeError('root-invalid', 'this folder overlaps application storage and cannot be granted')
    }
  }
  if (primary !== undefined && primary !== '' && (overlaps(real, primary) || overlaps(resolved, primary))) {
    throw new ScopeError('root-invalid', "this folder overlaps the project's own folder, which is already granted")
  }
  return real
}

/** Validate a user-supplied access level. */
export function parseAccess(raw: unknown): 'read' | 'write' {
  if (raw === 'read' || raw === 'write') return raw
  throw new ScopeError('root-invalid', "access must be 'read' or 'write'")
}

/**
 * Resolve a project's `additionalDirectories` to folders. Project
 * references follow the referenced project's CURRENT folder; references to
 * removed projects, and entries that now overlap the primary, are skipped.
 */
export function projectGrants(record: ProjectRecord, lookup: (projectId: ProjectId) => ProjectRecord | undefined): GrantedRoot[] {
  const roots: GrantedRoot[] = []
  for (const entry of record.additionalDirectories ?? []) {
    const folder = entry.kind === 'path' ? entry.path : lookup(entry.projectId)?.path
    if (folder === undefined || overlaps(folder, record.path)) continue
    roots.push({ path: folder, access: entry.access })
  }
  return roots
}

/** Merge grant lists by folder; `write` wins over `read` on the same folder. */
export function mergeGrants(...lists: ReadonlyArray<readonly (GrantedRoot | SessionGrant)[]>): GrantedRoot[] {
  const merged: GrantedRoot[] = []
  for (const list of lists) {
    for (const root of list) {
      const index = merged.findIndex((existing) => samePath(existing.path, root.path))
      if (index < 0) merged.push({ path: root.path, access: root.access })
      else if (root.access === 'write') merged[index] = { path: merged[index]?.path ?? root.path, access: 'write' }
    }
  }
  return merged
}
