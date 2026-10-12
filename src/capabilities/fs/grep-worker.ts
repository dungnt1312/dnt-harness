/**
 * Grep's matching loop runs in a worker thread. The pattern comes from the
 * model, and JavaScript regular expressions can backtrack catastrophically
 * (`(a+)+$` on a short line takes minutes); on the main thread that would
 * freeze every session, the HTTP server, and the abort that should stop it.
 * A worker can be terminated mid-match, so a timeout or a Stop always wins.
 *
 * The worker body is plain CommonJS evaluated from a string: it needs no
 * loader, so it runs the same under tsx, vitest, and a bundled build.
 */
import { Worker } from 'node:worker_threads'

export interface GrepFile {
  /** Absolute path to read. */
  readonly full: string
}

/** What Grep reports: matching lines (with context), matching files, or per-file counts. */
export type GrepMode = 'content' | 'files_with_matches' | 'count'

/**
 * One output row. `file` indexes the `files` array. `content` mode yields
 * `match` and `context` rows plus a `separator` between non-adjacent groups
 * (only when context was requested); the other modes yield one row per file.
 */
export type GrepRow =
  | { readonly kind: 'match' | 'context'; readonly file: number; readonly line: number; readonly text: string }
  | { readonly kind: 'separator' }
  | { readonly kind: 'file'; readonly file: number }
  | { readonly kind: 'count'; readonly file: number; readonly count: number }

export interface GrepRun {
  readonly rows: readonly GrepRow[]
  /** The limit stopped the search before every file was read. */
  readonly truncated: boolean
  /** Files skipped because they exceed `maxFileBytes`. */
  readonly skippedLarge: number
}

export interface GrepOptions {
  /** Cap on matches (`content`) or files (`files_with_matches`, `count`). */
  readonly maxHits: number
  readonly maxFileBytes: number
  readonly timeoutMs: number
  readonly mode?: GrepMode
  readonly ignoreCase?: boolean
  /** Context lines before / after each match (`content` mode only). */
  readonly before?: number
  readonly after?: number
  readonly signal?: AbortSignal
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { pattern, flags, files, maxHits, maxFileBytes, mode, before, after } = workerData
const regex = new RegExp(pattern, flags)
const rows = []
const withContext = before > 0 || after > 0
let hits = 0
let truncated = false
let skippedLarge = 0
outer: for (let f = 0; f < files.length; f++) {
  let size
  try { size = fs.statSync(files[f].full).size } catch { continue }
  if (size > maxFileBytes) { skippedLarge++; continue }
  let buf
  try { buf = fs.readFileSync(files[f].full) } catch { continue }
  // Binary files (a NUL in the first 8 KiB) are not searched.
  if (buf.subarray(0, 8192).includes(0)) continue
  const lines = buf.toString('utf8').split(/\\r?\\n/)
  if (mode !== 'content') {
    let count = 0
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) continue
      count++
      if (mode === 'files_with_matches') break
    }
    if (count === 0) continue
    if (hits >= maxHits) { truncated = true; break }
    rows.push(mode === 'count' ? { kind: 'count', file: f, count } : { kind: 'file', file: f })
    hits++
    continue
  }
  // Last line index already emitted for this file, and how many trailing
  // context lines the latest match still owes.
  let printed = -1
  let owed = 0
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      if (hits >= maxHits) { truncated = true; break outer }
      const start = Math.max(i - before, printed + 1)
      if (withContext && rows.length > 0 && (printed === -1 || start > printed + 1)) rows.push({ kind: 'separator' })
      for (let c = start; c < i; c++) rows.push({ kind: 'context', file: f, line: c + 1, text: lines[c] })
      rows.push({ kind: 'match', file: f, line: i + 1, text: lines[i] })
      hits++
      printed = i
      owed = after
    } else if (owed > 0) {
      rows.push({ kind: 'context', file: f, line: i + 1, text: lines[i] })
      printed = i
      owed--
    }
  }
}
parentPort.postMessage({ rows, truncated, skippedLarge })
`

export class GrepTimeoutError extends Error {}

/** Run the search; rejects on timeout, abort, or a worker failure. */
export function runGrep(pattern: string, files: readonly GrepFile[], options: GrepOptions): Promise<GrepRun> {
  if (options.signal?.aborted === true) return Promise.reject(new Error('cancelled: stop requested during search'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        pattern,
        flags: options.ignoreCase === true ? 'i' : '',
        files: files.map((file) => ({ full: file.full })),
        maxHits: options.maxHits,
        maxFileBytes: options.maxFileBytes,
        mode: options.mode ?? 'content',
        before: options.before ?? 0,
        after: options.after ?? 0,
      },
      // A runaway match cannot take the host's heap with it.
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    })
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      action()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new GrepTimeoutError(`search exceeded ${Math.round(options.timeoutMs / 1000)}s`)))
    }, options.timeoutMs)
    const onAbort = (): void => finish(() => reject(new Error('cancelled: stop requested during search')))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (run: GrepRun) => finish(() => resolve(run)))
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) => finish(() => reject(new Error(`search worker exited with code ${code}`))))
  })
}
