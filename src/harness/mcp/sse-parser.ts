/**
 * Incremental SSE reader for LF and CRLF frames. Comments and event names
 * are ignored; `data:` lines are joined with `\n` per the SSE spec.
 */
import { MCP_LIMITS } from './limits.ts'

export interface SseEvent {
  readonly data: string
}

export class SseParser {
  private buffer = ''
  private bytes = 0

  push(chunk: string): SseEvent[] {
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes > MCP_LIMITS.maxSseBytes) {
      throw new Error('SSE payload exceeds the decoded byte limit')
    }
    this.buffer += chunk
    const events: SseEvent[] = []
    for (;;) {
      const matched = /\r?\n\r?\n/.exec(this.buffer)
      if (matched === null || matched.index === undefined) break
      const frame = this.buffer.slice(0, matched.index)
      this.buffer = this.buffer.slice(matched.index + matched[0].length)
      const data = dataOf(frame)
      if (data !== undefined) events.push({ data })
    }
    return events
  }

  /** Bytes still waiting for a frame boundary. */
  get pendingBytes(): number {
    return Buffer.byteLength(this.buffer)
  }
}

function dataOf(frame: string): string | undefined {
  const lines: string[] = []
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) continue
    if (!rawLine.startsWith('data:')) continue
    lines.push(rawLine.slice(5).replace(/^ /, ''))
  }
  if (lines.length === 0) return undefined
  return lines.join('\n')
}
