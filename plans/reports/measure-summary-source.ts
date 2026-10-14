import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectForSummary } from '../../src/harness/context/compaction.ts'
import type { SessionEvent } from '../../src/harness/session/events.ts'

// Read-only measurement: nothing is written and no model is called.
const file = path.join(os.homedir(), '.dnt-harness/data/workspaces/ws-mur65pzr745ftn/sessions/session-mv5ffu5ceex0a5/events.jsonl')
const events = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEvent).filter(e => e.seq <= 25891)
const after = projectForSummary(events, 25891, undefined, 8840)
console.log(JSON.stringify({ chars: after.length, chunksOf199k: +(after.length / 199_000).toFixed(2) }))
