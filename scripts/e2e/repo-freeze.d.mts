// Type declarations for repo-freeze.mjs (consumed by tests/scripts).
export class RepoSafetyError extends Error {
  constructor(message: string, paths?: string[])
  paths: string[]
}

export interface IndexEntry { mode: string; oid: string; path: string; ita: boolean }
export type WorktreeLayer =
  | { path: string; state: 'deleted' }
  | { path: string; state: 'same'; mode: string; oid: string }
  | { path: string; state: 'modified'; mode: string; oid: string; bytes: Buffer }
export interface UntrackedFile { path: string; mode: string; oid: string; bytes: Buffer }
export type Fingerprint = Record<string, string | null>

export interface Snapshot {
  root: string
  objectFormat: string
  head: string | null
  headRef: string | null
  entries: IndexEntry[]
  worktree: WorktreeLayer[]
  untracked: UntrackedFile[]
  untrackedSkipped: number
  pack: Buffer | null
  fingerprint: Fingerprint
}

export interface Manifest {
  head: string | null
  headRef: string | null
  refs: Record<string, string>
  meta: Record<string, string>
  index: Record<string, string>
  files: Record<string, string>
}
export interface ChangeSet { added: string[]; modified: string[]; deleted: string[] }
export interface Drift { drifted: boolean; files: ChangeSet; index: ChangeSet; refs: ChangeSet; head: boolean; meta: string[] }

export function scratchDir(): string
export function resolveGitExecutable(env?: NodeJS.ProcessEnv, excludeDirs?: string[]): string
export function gitPath(): string
export function hardenedGitEnv(base?: NodeJS.ProcessEnv): Record<string, string>
export function hardenedGitArgs(): string[]
export function git(dir: string, args: string[], options?: { input?: string | Buffer; allowFail?: boolean }): Buffer
export function gitBlobId(bytes: Buffer, format?: string): string
export function windowsPathProblem(gitPath: string): string | null
export function isSensitivePath(gitPath: string): boolean
export function unsafeComponent(part: string, platform?: NodeJS.Platform): string | null
export function safeAbs(dir: string, gitPath: string, platform?: NodeJS.Platform): string
export function sourceFingerprint(source: string): Fingerprint
export function compareFingerprints(before: Record<string, unknown>, after: Record<string, unknown>): string[]
export function freezeSource(source: string, options?: { includeUntracked?: boolean; platform?: NodeJS.Platform }): Snapshot
export function createDisposableDir(dir: string, registry: string): string
export function assertDisposable(dir: string, registry: string): void
export function buildDisposableCopy(snapshot: Snapshot, dir: string, registry: string): string
export function walkFiles(dir: string, format?: string): Map<string, { mode: string; oid: string }>
export function verifyDisposableCopy(snapshot: Snapshot, dir: string): void
export function targetManifest(dir: string): Manifest
export function diffManifests(before: Manifest, after: Manifest): Drift
export function describeDrift(drift: Drift): string[]
