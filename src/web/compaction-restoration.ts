/**
 * Bounded restoration after a compaction: the few things a summary cannot be
 * trusted to carry exactly — the task list, what is still running, the skills
 * the conversation loaded and the files it was working on.
 *
 * Everything here is derived from the log up to the cutoff and from the files
 * as they are NOW, read under the session's current grants. Nothing is a
 * permission: reading a file here does not let the agent Edit it (the agent
 * must Read it itself), and a path the grants no longer allow is reported as
 * denied, never returned from memory.
 */
import { promises as fs } from 'node:fs'
import { resolveInGrants } from '../capabilities/fs/grants.ts'
import { estimateTokens } from '../harness/context/budget.ts'
import type { SessionEvent } from '../harness/session/events.ts'
import type { ToolExecution } from '../harness/tools/types.ts'

export const RESTORATION_MAX_FILES = 5
export const RESTORATION_FILE_TOKENS = 5_000
export const RESTORATION_FILES_TOTAL_TOKENS = 20_000
export const RESTORATION_SKILL_TOKENS = 5_000
export const RESTORATION_SKILLS_TOTAL_TOKENS = 25_000
export const RESTORATION_TOTAL_TOKENS = 25_000

export type RestorationStatus = 'included' | 'truncated' | 'reference' | 'missing' | 'denied'
export interface RestorationSection {
  readonly kind: 'todo' | 'runtime' | 'skill' | 'file'
  readonly name: string
  readonly status: RestorationStatus
  /** Estimated tokens of the content this section carries; 0 for a reference. */
  readonly tokens: number
}
export interface Restoration {
  readonly text: string
  /** Estimated tokens of `text`. */
  readonly tokens: number
  readonly sections: readonly RestorationSection[]
}

/** Required state (task list, running work) does not fit the cap: adoption must not shorten it silently. */
export class RestorationOverflow extends Error {}

type Block = { readonly section: RestorationSection; readonly text: string }

const FILE_BYTES_READ = RESTORATION_FILE_TOKENS * 4 * 4 + 1

interface Used { readonly seq: number; readonly name: string; readonly args: Record<string, unknown>; readonly output: string }

/** Tool calls that finished successfully at or before the cutoff, oldest first. */
function successfulCalls(events: readonly SessionEvent[], cutoff: number): Used[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const used: Used[] = []
  for (const event of events) {
    if (event.seq > cutoff) break
    if (event.type === 'tool/call') calls.set(event.call.id, { name: event.call.name, args: event.call.args })
    else if (event.type === 'tool/result' && event.ok && event.recovery !== true) {
      const call = calls.get(event.callId)
      if (call !== undefined) used.push({ seq: event.seq, name: call.name, args: call.args, output: event.output })
    }
  }
  return used
}

function todoBlock(used: readonly Used[]): Block | undefined {
  const latest = used.findLast((call) => call.name === 'TodoWrite')
  const todos = latest?.args['todos']
  if (!Array.isArray(todos) || todos.length === 0) return undefined
  const lines = todos.flatMap((item) => {
    const row = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    return typeof row['content'] === 'string' ? [`- [${String(row['status'])}] ${row['content']}`] : []
  })
  if (lines.length === 0) return undefined
  const text = `Task list (latest):\n${lines.join('\n')}`
  return { section: { kind: 'todo', name: 'todo', status: 'included', tokens: estimateTokens(text) }, text }
}

function runtimeBlock(events: readonly SessionEvent[], cutoff: number): Block | undefined {
  const agents = new Map<string, string>()
  const processes = new Map<string, string>()
  for (const event of events) {
    if (event.seq > cutoff) break
    if (event.type === 'agent/child-spawn') agents.set(event.childSessionId, `${event.definition}${event.objective !== undefined ? `: ${event.objective}` : ''}`)
    else if (event.type === 'agent/child-result') agents.delete(event.childSessionId)
    else if (event.type === 'process/start') processes.set(event.processId, `${event.command} (cwd ${event.cwd})`)
    else if (event.type === 'process/exit') processes.delete(event.processId)
  }
  const lines = [
    ...[...agents].map(([id, what]) => `- agent ${id} still running — ${what}`),
    ...[...processes].map(([id, what]) => `- background process ${id} still running — ${what}`),
  ]
  if (lines.length === 0) return undefined
  const text = `Still running when the conversation was compacted:\n${lines.join('\n')}`
  return { section: { kind: 'runtime', name: 'runtime', status: 'included', tokens: estimateTokens(text) }, text }
}

/** The newest successful load per skill name; a catalog listing is not a skill. */
function skillCandidates(used: readonly Used[]): Array<{ name: string; body: string }> {
  const latest = new Map<string, { seq: number; body: string }>()
  for (const call of used) {
    if (call.name !== 'Skill') continue
    const action = typeof call.args['action'] === 'string' ? call.args['action'].trim().toLowerCase() : undefined
    const name = typeof call.args['name'] === 'string' ? call.args['name'].trim() : ''
    if (name === '' || action === 'catalog' || action === 'list') continue
    latest.set(name, { seq: call.seq, body: call.output })
  }
  return [...latest].sort((a, b) => b[1].seq - a[1].seq).map(([name, value]) => ({ name, body: value.body }))
}

/** Most recently used files first, deduplicated by the path as the model wrote it. */
function fileCandidates(used: readonly Used[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const call of [...used].reverse()) {
    if (call.name !== 'Read' && call.name !== 'Write' && call.name !== 'Edit') continue
    const target = call.args['path']
    if (typeof target !== 'string' || target === '' || seen.has(target)) continue
    seen.add(target)
    order.push(target)
    if (order.length === RESTORATION_MAX_FILES) break
  }
  return order
}

const reference = (kind: 'skill' | 'file', name: string, status: RestorationStatus, why: string): Block => ({
  section: { kind, name, status, tokens: 0 },
  text: `- ${kind} ${name}: ${why}`,
})

/** Read one granted file as it is now; undefined content means a reference only. */
async function readFileNow(exec: BuildInput['exec'], target: string, signal: AbortSignal): Promise<Block> {
  signal.throwIfAborted()
  // No grant at all (a session without a folder) reads nothing.
  if (exec === undefined) return reference('file', target, 'denied', 'not restored — this session has no folder grant')
  let resolved: string
  try {
    resolved = await resolveInGrants(exec as ToolExecution, target, 'read')
  } catch {
    return reference('file', target, 'denied', 'not restored — outside the folders this session may read')
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(resolved, 'r')
    const info = await handle.stat()
    if (!info.isFile()) return reference('file', target, 'reference', 'not restored — not a regular file')
    const buffer = Buffer.alloc(Math.min(info.size, FILE_BYTES_READ))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    signal.throwIfAborted()
    if (info.size > FILE_BYTES_READ || buffer.subarray(0, bytesRead).includes(0)) {
      return reference('file', target, 'reference', info.size > FILE_BYTES_READ ? 'not restored — too large; Read it again if needed' : 'not restored — binary')
    }
    const content = buffer.subarray(0, bytesRead).toString('utf8')
    const tokens = estimateTokens(content)
    if (tokens > RESTORATION_FILE_TOKENS) return reference('file', target, 'reference', 'not restored — too large; Read it again if needed')
    return { section: { kind: 'file', name: target, status: 'included', tokens }, text: `File ${target} (current content; Read it before editing):\n${content}` }
  } catch (error) {
    if (signal.aborted) throw error
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? reference('file', target, 'missing', 'no longer exists')
      : reference('file', target, 'denied', 'not restored — could not be read')
  } finally {
    await handle?.close().catch(() => {})
  }
}

interface BuildInput {
  readonly events: readonly SessionEvent[]
  readonly cutoff: number
  /** The session's file grant right now; undefined when it has none. */
  readonly exec: Pick<ToolExecution, 'root' | 'additionalRoots' | 'deniedRoots' | 'memoryRoots' | 'hostStorageRoot'> | undefined
  readonly signal: AbortSignal
}

/**
 * The restoration for a checkpoint covering the log through `cutoff`, or
 * undefined when the conversation used nothing restorable. Throws
 * {@link RestorationOverflow} when required state alone exceeds the cap.
 */
export async function buildRestoration(input: BuildInput): Promise<Restoration | undefined> {
  input.signal.throwIfAborted()
  const used = successfulCalls(input.events, input.cutoff)
  const required = [todoBlock(used), runtimeBlock(input.events, input.cutoff)].filter((block): block is Block => block !== undefined)
  const requiredText = required.map((block) => block.text).join('\n\n')
  if (estimateTokens(requiredText) > RESTORATION_TOTAL_TOKENS) {
    throw new RestorationOverflow(`required state needs ${estimateTokens(requiredText)} tokens; the restoration cap is ${RESTORATION_TOTAL_TOKENS}`)
  }

  const blocks: Block[] = [...required]
  let total = estimateTokens(requiredText)
  const fits = (text: string): boolean => total + estimateTokens(`\n\n${text}`) <= RESTORATION_TOTAL_TOKENS
  const add = (block: Block): void => {
    // A block that no longer fits the aggregate becomes a reference rather than being cut mid-content.
    const chosen = fits(block.text) || block.section.tokens === 0
      ? block
      : reference(block.section.kind as 'skill' | 'file', block.section.name, 'reference', 'not restored — restoration budget exhausted')
    blocks.push(chosen)
    total += estimateTokens(`\n\n${chosen.text}`)
  }

  let skillTokens = 0
  for (const candidate of skillCandidates(used)) {
    input.signal.throwIfAborted()
    const full = estimateTokens(candidate.body)
    const body = full > RESTORATION_SKILL_TOKENS ? candidate.body.slice(0, RESTORATION_SKILL_TOKENS * 4) : candidate.body
    const tokens = estimateTokens(body)
    if (skillTokens + tokens > RESTORATION_SKILLS_TOTAL_TOKENS) {
      add(reference('skill', candidate.name, 'reference', 'not restored — skill budget exhausted; load it again if needed'))
      continue
    }
    skillTokens += tokens
    add({
      section: { kind: 'skill', name: candidate.name, status: full > RESTORATION_SKILL_TOKENS ? 'truncated' : 'included', tokens },
      text: `Skill ${candidate.name}${full > RESTORATION_SKILL_TOKENS ? ' (truncated)' : ''}:\n${body}`,
    })
  }

  let fileTokens = 0
  for (const target of fileCandidates(used)) {
    const block = await readFileNow(input.exec, target, input.signal)
    if (block.section.tokens > 0 && fileTokens + block.section.tokens > RESTORATION_FILES_TOTAL_TOKENS) {
      add(reference('file', target, 'reference', 'not restored — file budget exhausted; Read it again if needed'))
      continue
    }
    fileTokens += block.section.tokens
    add(block)
  }

  if (blocks.length === 0) return undefined
  const text = blocks.map((block) => block.text).join('\n\n')
  return { text, tokens: estimateTokens(text), sections: blocks.map((block) => block.section) }
}
