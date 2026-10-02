/**
 * The canonical JSONL event log format: one session's durable history is
 * `<dataDir>/sessions/<id>/events.jsonl`, one JSON object per line carrying
 * a schema version, the stamped fields, and the event payload.
 *
 * Durability here means the bytes reached the file and the file was synced
 * (`fsync`) before the write is acknowledged. Directory entries are synced
 * best-effort: Windows cannot fsync a directory handle, so rename durability
 * there relies on the platform's metadata journaling — a documented limit,
 * not a silent claim.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SessionEvent } from '../session/events.ts'

/** Bump when the line format breaks compatibility; readers refuse other versions. */
export const EVENT_SCHEMA_VERSION = 1

/** Storage-layer failure kinds the harness classifies. */
export type SessionLogErrorKind = 'corruption' | 'schema' | 'io'

/** A storage failure with its durable-log context attached. */
export class SessionLogError extends Error {
  constructor(
    readonly kind: SessionLogErrorKind,
    message: string,
    readonly filePath?: string,
    readonly lineNumber?: number,
  ) {
    super(message)
    this.name = 'SessionLogError'
  }
}

/** Encode one stamped event as a canonical JSONL line. */
export function encodeEventLine(event: SessionEvent): string {
  return `${JSON.stringify({ v: EVENT_SCHEMA_VERSION, ...event })}\n`
}

/** Minimal per-line validation: the fields every stamped event carries. */
function validateRecord(parsed: unknown, filePath: string, lineNumber: number): SessionEvent {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionLogError('schema', `line ${lineNumber} is not a JSON object`, filePath, lineNumber)
  }
  const record = parsed as Record<string, unknown>
  if (record['v'] !== EVENT_SCHEMA_VERSION) {
    throw new SessionLogError(
      'schema',
      `line ${lineNumber} carries schema version ${String(record['v'])}, expected ${EVENT_SCHEMA_VERSION}`,
      filePath,
      lineNumber,
    )
  }
  if (typeof record['type'] !== 'string') {
    throw new SessionLogError('schema', `line ${lineNumber} has no event type`, filePath, lineNumber)
  }
  if (typeof record['seq'] !== 'number' || !Number.isInteger(record['seq']) || record['seq'] < 1) {
    throw new SessionLogError('schema', `line ${lineNumber} has an invalid seq`, filePath, lineNumber)
  }
  if (typeof record['timestamp'] !== 'number') {
    throw new SessionLogError('schema', `line ${lineNumber} has an invalid timestamp`, filePath, lineNumber)
  }
  return record as unknown as SessionEvent
}

export interface EventLogRead {
  readonly events: SessionEvent[]
  /** A truncated final record was quarantined and dropped from the log. */
  readonly truncatedTail: boolean
}

/**
 * Read and validate one event log. Middle corruption (a bad record followed
 * by more records) is surfaced as a `corruption` error and blocks automatic
 * continuation — it is never silently skipped. A truncated final record
 * (the classic crash-while-writing shape) is quarantined verbatim to
 * `<file>.partial-<timestamp>` and the file is repaired to the good prefix.
 * Sequence numbers must run 1, 2, 3, … without gaps or repeats.
 */
export async function readEventLog(filePath: string): Promise<EventLogRead> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], truncatedTail: false }
    }
    throw new SessionLogError('io', `cannot read '${filePath}': ${String(error)}`, filePath)
  }

  const lines = raw.split('\n')
  // A trailing '' after the final newline is normal; any other empty line is
  // corruption (or a torn final write, handled below).
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const events: SessionEvent[] = []
  let truncatedTail = false
  // Character offset where the current line starts in `raw`.
  let lineStart = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const lineNumber = i + 1
    const isLast = i === lines.length - 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (!isLast) {
        throw new SessionLogError('corruption', `corrupt record at line ${lineNumber} of '${filePath}'`, filePath, lineNumber)
      }
      // Torn final write: quarantine the raw bytes, then repair the file to
      // the good prefix (everything before this line) so later appends start
      // from a clean tail.
      await quarantineTail(filePath, raw.slice(0, lineStart), raw.slice(lineStart))
      truncatedTail = true
      break
    }
    lineStart += line.length + 1
    const event = validateRecord(parsed, filePath, lineNumber)
    if (event.seq !== events.length + 1) {
      throw new SessionLogError(
        'corruption',
        `sequence break at line ${lineNumber} of '${filePath}': expected seq ${events.length + 1}, found ${event.seq}`,
        filePath,
        lineNumber,
      )
    }
    events.push(event)
  }
  // A crash between writing a complete record and its newline leaves a valid
  // but unterminated final line. The next append would glue onto it and the
  // following load would discard both as one torn line: terminate it now.
  if (!truncatedTail && raw.length > 0 && !raw.endsWith('\n')) {
    await terminateLastLine(filePath)
  }
  return { events, truncatedTail }
}

async function terminateLastLine(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, 'a')
    try {
      await handle.write('\n', null, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new SessionLogError('io', `cannot terminate the final record of '${filePath}': ${String(error)}`, filePath)
  }
}

/** Preserve the torn tail verbatim, then truncate the log to the good prefix. */
async function quarantineTail(filePath: string, goodPrefix: string, tornLine: string): Promise<void> {
  const goodBytes = Buffer.byteLength(goodPrefix, 'utf8')
  const quarantine = `${filePath}.partial-${Date.now().toString(36)}`
  try {
    await fs.writeFile(quarantine, tornLine, 'utf8')
    const handle = await fs.open(filePath, 'r+')
    try {
      await handle.truncate(goodBytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw new SessionLogError('io', `cannot repair torn tail of '${filePath}': ${String(error)}`, filePath)
  }
}

/**
 * Append one canonical line through an open handle and sync it. The sync is
 * the durability barrier: the caller may only acknowledge the record after
 * this resolves.
 */
export async function appendEventLine(handle: fs.FileHandle, line: string): Promise<void> {
  await handle.write(line, null, 'utf8')
  await handle.sync()
}

/**
 * Replace a whole file atomically: write a validated temp file, sync it,
 * rename over the target, and best-effort sync the directory. Used for
 * `summary.json` rewrites and whole-log replacements (fork).
 */
export async function replaceFileAtomic(filePath: string, contents: string): Promise<void> {
  const temp = `${filePath}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const handle = await fs.open(temp, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temp, filePath)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw new SessionLogError('io', `cannot replace '${filePath}': ${String(error)}`, filePath)
  }
  await syncDirectory(path.dirname(filePath))
}

/** Best-effort directory sync; Windows has no directory fsync — documented limit. */
export async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Windows: EPERM on directory handles. Metadata durability there is the
    // platform's own concern; record contents are already synced.
  }
}
