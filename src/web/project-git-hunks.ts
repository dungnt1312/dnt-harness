/**
 * Per-hunk staging (a port of Zed `git_store.rs` index writes): the displayed
 * hunks of one file's HEAD↔worktree diff, each with a staged/unstaged/partial
 * status, and the byte-exact index/worktree rewrites behind the Stage,
 * Unstage and Restore buttons.
 *
 * Zed never applies a patch: it recomputes the index text and writes a blob
 * (`hash-object -w --stdin` + `update-index --cacheinfo`). Line handling is
 * byte buffers split after `\n`, so CRLF and a missing final newline survive.
 */
import { createHash } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import path from 'node:path'
import { ProjectGitError } from './project-git.ts'
import { git, type Context, type Step } from './project-git-ops.ts'

export type GitHunkStatus = 'staged' | 'unstaged' | 'partial'

/** The client-facing identity of one displayed hunk; `fingerprint` guards staleness. */
export interface GitHunkRef {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly fingerprint: string
}

export interface GitHunk extends GitHunkRef {
  readonly status: GitHunkStatus
}

/** One `@@` block with its marked lines (`-x`, `+y`, ` ctx`, `\\ no newline`). */
export interface RawHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly string[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Split a unified diff into `@@` blocks, keeping each block's marked lines
 * (`-x`, `+y`, ` ctx`). A `\ No newline at end of file` note belongs to the
 * line before it, so it is folded into that entry.
 */
export function parseHunks(unifiedDiff: string): RawHunk[] {
  const hunks: RawHunk[] = []
  let current: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } | null = null
  for (const line of unifiedDiff.replace(/\r\n/g, '\n').split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      if (current !== null && current.lines.length > 0) hunks.push(current)
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      continue
    }
    if (current !== null && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      current.lines.push(line)
    } else if (current !== null && line.startsWith('\\')) {
      // git's "\ No newline at end of file" note describes the previous
      // line; the hunk's identity does not depend on it, so it is dropped.
    }
  }
  if (current !== null && current.lines.length > 0) hunks.push(current)
  return hunks
}

/** sha1 (hex) of the hunk's `-`/`+` lines joined with `\n`, markers kept. */
export function hunkFingerprint(lines: readonly string[]): string {
  const marked = lines.filter((line) => line.startsWith('-') || line.startsWith('+'))
  return createHash('sha1').update(marked.join('\n')).digest('hex')
}

/**
 * A git range as a half-open line interval `[start, end)`. A count of 0 is
 * git's "between line `start` and `start+1`": the empty point `[start+1,
 * start+1)`.
 */
export function rangeOf(start: number, count: number): readonly [number, number] {
  return count === 0 ? [start + 1, start + 1] : [start, start + count]
}

/**
 * Whether two half-open intervals share a line. Two non-empty ranges need a
 * real overlap; an empty point matches a range that surrounds it and another
 * empty point at the same position.
 */
export function rangesOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  const [a0, a1] = a
  const [b0, b1] = b
  const aEmpty = a0 >= a1
  const bEmpty = b0 >= b1
  if (aEmpty || bEmpty) return a0 <= b1 && b0 <= a1
  return a0 < b1 && b0 < a1
}

/**
 * Zed `secondary_status` (`project_diff.rs:354-366`) for one displayed hunk:
 * `staged` when no index↔worktree change touches its worktree range,
 * `unstaged` when no HEAD↔index change touches its HEAD range, else `partial`.
 */
export function hunkStatus(display: RawHunk, unstaged: readonly RawHunk[], staged: readonly RawHunk[]): GitHunkStatus {
  const oldRange = rangeOf(display.oldStart, display.oldLines)
  const newRange = rangeOf(display.newStart, display.newLines)
  const stagedPart = staged.some((hunk) => rangesOverlap(rangeOf(hunk.oldStart, hunk.oldLines), oldRange))
  const unstagedPart = unstaged.some((hunk) => rangesOverlap(rangeOf(hunk.newStart, hunk.newLines), newRange))
  if (!unstagedPart) return 'staged'
  if (!stagedPart) return 'unstaged'
  return 'partial'
}

/** Split a buffer into lines: pieces that end after each `\n`; the last may lack it. */
function splitLines(text: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let index = text.indexOf(10); index >= 0; index = text.indexOf(10, index + 1)) {
    lines.push(text.subarray(start, index + 1))
    start = index + 1
  }
  if (start < text.length) lines.push(text.subarray(start))
  return lines
}

/** Lines `[start, start+count)` (1-based) of a text, byte-exact. */
export function linesOf(text: Buffer, start: number, count: number): Buffer[] {
  if (count <= 0) return []
  return splitLines(text).slice(start - 1, start - 1 + count)
}

/** Replace lines `[start, start+count)` (1-based) with `lines`; `count` 0 inserts after line `start` (0 = at the very top). */
export function replaceLines(text: Buffer, start: number, count: number, lines: readonly Buffer[]): Buffer {
  const all = splitLines(text)
  // With count 0 nothing is removed, so `start` names the line to insert
  // AFTER (start 0 = the top); with count > 0 line `start` is the first
  // replaced.
  const at = start <= 0 ? 0 : count === 0 ? Math.min(start, all.length) : Math.min(start - 1, all.length)
  const head = all.slice(0, at)
  const tail = all.slice(Math.min(at + Math.max(count, 0), all.length))
  return Buffer.concat([...head, ...lines, ...tail])
}

/** The hunks `gitDiff` reports: one per displayed `@@` block, empty when controls are not offered. */
export function hunksFrom(
  status: { hasHead: boolean; trackedInHead: boolean; conflicted: boolean; created: boolean },
  displayText: string,
  unstagedDiff: string,
  stagedDiff: string,
): GitHunk[] {
  if (!status.hasHead || !status.trackedInHead || status.conflicted || status.created) return []
  const display = parseHunks(displayText)
  if (display.length === 0) return []
  const unstaged = parseHunks(unstagedDiff)
  const staged = parseHunks(stagedDiff)
  return display.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    fingerprint: hunkFingerprint(hunk.lines),
    status: hunkStatus(hunk, unstaged, staged),
  }))
}

export const STALE_HUNK = 'The file changed since the diff was shown. Refresh and try again.'

/** Find the current hunk matching a client reference, or throw the stale error. */
export function matchHunk(current: readonly GitHunk[], ref: GitHunkRef): GitHunk {
  const found = current.find((hunk) =>
    hunk.oldStart === ref.oldStart && hunk.oldLines === ref.oldLines
    && hunk.newStart === ref.newStart && hunk.newLines === ref.newLines
    && hunk.fingerprint === ref.fingerprint)
  if (found === undefined) throw new ProjectGitError(STALE_HUNK)
  return found
}

// ── the report gitDiff returns ────────────────────────────────────

/** Read one side of a path: HEAD (`git show HEAD:<rel>`) or the index (`git show :<rel>`). */
async function showRef(run: (args: readonly string[]) => Promise<{ code: number; stdout: Buffer }>, spec: string): Promise<Buffer | null> {
  const result = await run(['show', spec])
  return result.code === 0 ? result.stdout : null
}

/**
 * The hunks of one file's diff, computed inside `gitDiff`: `read` runs git
 * queries (trust-aware), `displayText` is the `--unified=3 HEAD` diff text it
 * already printed, and `change` is the file's status entry (absent when the
 * path is clean or untracked — then hunk controls are simply not offered).
 */
export async function hunksFor(
  root: string,
  rel: string,
  trusted: boolean,
  displayText: string,
  read: (args: readonly string[]) => Promise<{ ok: boolean; stdout: Buffer; code: number }>,
  hasHead: boolean,
  conflicted: boolean,
): Promise<GitHunk[]> {
  if (!hasHead) return []
  if (conflicted) return []
  // A project may sit in a subdirectory of the repository: `show` and the
  // staged diff name repository paths, so the prefix is resolved once.
  const prefix = (await read(['rev-parse', '--show-prefix'])).stdout.toString('utf8').trim()
  const repoRel = prefix === '' ? rel : `${prefix}${rel}`
  // Only a file tracked in HEAD gets hunk controls: a new or untracked file
  // stages as a whole, like Zed's project diff does.
  const headText = await showRef(read, `HEAD:${repoRel}`)
  if (headText === null) return []
  // The index must have the path; a clean file has no hunks anyway.
  const [unstagedDiff, stagedDiff] = await Promise.all([
    read(['diff', '--no-color', '-U0', '--no-ext-diff', '--', rel]),
    read(['diff', '--no-color', '-U0', '--no-ext-diff', '--cached', 'HEAD', '--', repoRel]),
  ])
  if (unstagedDiff.code !== 0 || stagedDiff.code !== 0) return []
  return hunksFrom({ hasHead: true, trackedInHead: true, conflicted: false, created: false },
    displayText, unstagedDiff.stdout.toString('utf8'), stagedDiff.stdout.toString('utf8'))
}

// ── operations (Zed set_index_text, git_store.rs:1424-1649) ───────

/** The current displayed hunks of `rel`, recomputed to catch a stale client ref. */
async function currentHunks(ctx: Context, rel: string): Promise<GitHunk[]> {
  const display = await git(ctx, ['diff', '--no-color', '--unified=3', '--find-renames', 'HEAD', '--', rel])
  if (!display.ok) throw new ProjectGitError(`git cannot diff '${rel}'`)
  return hunksFor(ctx.root, rel, ctx.trusted, display.stdout,
    (args) => git(ctx, args).then((step) => ({ code: step.ok ? 0 : 1, stdout: Buffer.from(step.stdout, 'utf8') })), true, false)
}

/** The repository-relative path of a project-relative one (a project may sit in a subdirectory). */
async function repoRelOf(ctx: Context, rel: string): Promise<string> {
  const prefix = await git(ctx, ['rev-parse', '--show-prefix'])
  const trim = prefix.stdout.trim()
  return trim === '' ? rel : `${trim}${rel}`
}

/** The lines of one side, as raw bytes. */
async function sideText(ctx: Context, spec: string): Promise<Buffer | null> {
  const result = await git(ctx, ['show', spec])
  return result.ok ? Buffer.from(result.stdout, 'utf8') : null
}

/**
 * Write `text` as the file's index content (Zed `set_index_text`): one blob
 * via `hash-object -w --stdin --path`, then `update-index --cacheinfo`. A
 * null `text` (the file deleted from the index) force-removes the path.
 */
async function setIndexText(ctx: Context, rel: string, text: Buffer | null): Promise<Step> {
  const repoRel = await repoRelOf(ctx, rel)
  if (text === null) return git(ctx, ['update-index', '--force-remove', '--', repoRel])
  const hashed = await gitWithStdin(ctx, ['hash-object', '-w', '--stdin', '--path', repoRel], text)
  if (!hashed.ok) return { ok: false, stdout: hashed.stdout, stderr: `Failed to stage:\n${hashed.stderr}` }
  const sha = hashed.stdout.trim()
  const mode = await indexModeOf(ctx, rel)
  const written = await git(ctx, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${repoRel}`])
  return written.ok ? written : { ok: false, stdout: written.stdout, stderr: `Failed to stage:\n${written.stderr}` }
}

/** `100755` when the worktree file is executable (or was, in the index), else `100644`. */
async function indexModeOf(ctx: Context, rel: string): Promise<'100755' | '100644'> {
  try {
    const stat = await fsPromises.stat(path.join(ctx.root, rel))
    if ((stat.mode & 0o111) !== 0) return '100755'
  } catch {
    // deleted from the worktree: the index still knows the mode
  }
  const listed = await git(ctx, ['ls-files', '-s', '--', rel])
  return listed.stdout.startsWith('100755 ') ? '100755' : '100644'
}

/** The zero-context index↔worktree hunks whose worktree range overlaps `range`. */
async function unstagedZero(ctx: Context, rel: string, range: readonly [number, number]): Promise<RawHunk[]> {
  const diff = await git(ctx, ['diff', '--no-color', '-U0', '--no-ext-diff', '--', rel])
  return parseHunks(diff.stdout).filter((hunk) => rangesOverlap(rangeOf(hunk.newStart, hunk.newLines), range))
}

/** The zero-context HEAD↔index hunks whose HEAD range overlaps `range`. */
async function stagedZero(ctx: Context, rel: string, range: readonly [number, number]): Promise<RawHunk[]> {
  const diff = await git(ctx, ['diff', '--no-color', '-U0', '--no-ext-diff', '--cached', 'HEAD', '--', await repoRelOf(ctx, rel)])
  return parseHunks(diff.stdout).filter((hunk) => rangesOverlap(rangeOf(hunk.oldStart, hunk.oldLines), range))
}

/** `stage-hunk`: move the worktree lines of the hunk's unstaged part into the index. */
export async function stageHunk(ctx: Context, rel: string, ref: GitHunkRef): Promise<Step> {
  const hunk = matchHunk(await currentHunks(ctx, rel), ref)
  const worktree = await worktreeText(ctx, rel)
  if (worktree === null) {
    // The file is gone from the worktree: staging the hunk stages the deletion.
    return setIndexText(ctx, rel, null)
  }
  const index = await sideText(ctx, `:${await repoRelOf(ctx, rel)}`)
  if (index === null) throw new ProjectGitError(`'${rel}' is not in the index`)
  let next = index
  // Descending oldStart, so an earlier rewrite does not shift a later range.
  const hunks = (await unstagedZero(ctx, rel, rangeOf(hunk.newStart, hunk.newLines)))
    .sort((a, b) => b.oldStart - a.oldStart)
  for (const w of hunks) {
    next = replaceLines(next, w.oldStart, w.oldLines, linesOf(worktree, w.newStart, w.newLines))
  }
  if (hunks.length === 0 && Buffer.compare(next, index) === 0) {
    // Nothing unstaged overlaps: the hunk is already fully staged.
    return { ok: true, stdout: '', stderr: '' }
  }
  return setIndexText(ctx, rel, next)
}

/** `unstage-hunk`: put the HEAD lines of the hunk's staged part back into the index. */
export async function unstageHunk(ctx: Context, rel: string, ref: GitHunkRef): Promise<Step> {
  const hunk = matchHunk(await currentHunks(ctx, rel), ref)
  const head = await sideText(ctx, `HEAD:${await repoRelOf(ctx, rel)}`)
  if (head === null) throw new ProjectGitError(`'${rel}' is not tracked in HEAD`)
  const index = await sideText(ctx, `:${await repoRelOf(ctx, rel)}`)
  if (index === null) throw new ProjectGitError(`'${rel}' is not in the index`)
  let next = index
  const hunks = (await stagedZero(ctx, rel, rangeOf(hunk.oldStart, hunk.oldLines)))
    .sort((a, b) => b.newStart - a.newStart)
  for (const s of hunks) {
    next = replaceLines(next, s.newStart, s.newLines, linesOf(head, s.oldStart, s.oldLines))
  }
  return setIndexText(ctx, rel, next)
}

/** `restore-hunk`: put the hunk's HEAD lines back into the worktree; the index is untouched. */
export async function restoreHunk(ctx: Context, rel: string, ref: GitHunkRef): Promise<Step> {
  const hunk = matchHunk(await currentHunks(ctx, rel), ref)
  const head = await sideText(ctx, `HEAD:${await repoRelOf(ctx, rel)}`)
  if (head === null) throw new ProjectGitError(`'${rel}' is not tracked in HEAD`)
  const worktree = await worktreeText(ctx, rel)
  if (worktree === null) {
    // Deleted: restoring the hunk restores the whole file's HEAD lines.
    await fsPromises.writeFile(path.join(ctx.root, rel), head)
    return { ok: true, stdout: '', stderr: '' }
  }
  const next = replaceLines(worktree, hunk.newStart, hunk.newLines, linesOf(head, hunk.oldStart, hunk.oldLines))
  await fsPromises.writeFile(path.join(ctx.root, rel), next)
  return { ok: true, stdout: '', stderr: '' }
}

/** The worktree bytes of `rel`; null when the file is gone. */
async function worktreeText(ctx: Context, rel: string): Promise<Buffer | null> {
  try {
    return await fsPromises.readFile(path.join(ctx.root, rel))
  } catch {
    return null
  }
}

/** One git command with `input` on stdin (`hash-object --stdin`). */
async function gitWithStdin(ctx: Context, args: readonly string[], input: Buffer): Promise<Step> {
  const { runGitCommand } = await import('./project-git.ts')
  const result = await ctx.run(ctx.root, args, { trusted: ctx.trusted, stdin: input, env: ctx.env })
  return { ok: result.code === 0, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
}
void git
