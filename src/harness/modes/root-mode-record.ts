import { createHash } from 'node:crypto'
import type { SessionAppendedEvent } from '../session/events.ts'
import type { ResolvedMode } from './types.ts'

type RootModeRecord = Extract<SessionAppendedEvent, { type: 'session/mode' }>

/**
 * A root's mode snapshot record. `revision` continues the root's own
 * sequence, so a later selection always supersedes an earlier one.
 */
export function rootModeRecord(resolved: ResolvedMode, revision: number): RootModeRecord {
  const snapshot = resolved.definition
  return {
    type: 'session/mode',
    modeId: snapshot.id,
    revision,
    snapshot,
    source: resolved.source,
    hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
  }
}
