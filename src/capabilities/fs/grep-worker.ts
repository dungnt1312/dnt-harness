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

export interface GrepHit {
  /** Index into the `files` array. */
  readonly file: number
  readonly line: number
  readonly text: string
}

export interface GrepRun {
  readonly hits: readonly GrepHit[]
  readonly truncated: boolean
  /** Files skipped because they exceed `maxFileBytes`. */
  readonly skippedLarge: number
}

export interface GrepOptions {
  readonly maxHits: number
  readonly maxFileBytes: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { pattern, files, maxHits, maxFileBytes } = workerData
const regex = new RegExp(pattern)
const hits = []
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
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      hits.push({ file: f, line: i + 1, text: lines[i] })
      if (hits.length >= maxHits) { truncated = true; break outer }
    }
  }
}
parentPort.postMessage({ hits, truncated, skippedLarge })
`

export class GrepTimeoutError extends Error {}

/** Run the search; rejects on timeout, abort, or a worker failure. */
export function runGrep(pattern: string, files: readonly GrepFile[], options: GrepOptions): Promise<GrepRun> {
  if (options.signal?.aborted === true) return Promise.reject(new Error('cancelled: stop requested during search'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, files: files.map((file) => ({ full: file.full })), maxHits: options.maxHits, maxFileBytes: options.maxFileBytes },
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
