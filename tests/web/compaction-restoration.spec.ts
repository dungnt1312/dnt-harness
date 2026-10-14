/**
 * Bounded restoration after a compaction: what the summary alone cannot give
 * back. Real temporary folders and the real file-grant policy — no permission
 * bypass mocks. Caps are the spec's: 5 files x 5k tokens (20k total), skills
 * 5k each (25k total), 25k overall, required state first.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../src/harness/session/events.ts'
import {
  RESTORATION_FILE_TOKENS,
  RESTORATION_FILES_TOTAL_TOKENS,
  RESTORATION_MAX_FILES,
  RESTORATION_SKILL_TOKENS,
  RESTORATION_SKILLS_TOTAL_TOKENS,
  RESTORATION_TOTAL_TOKENS,
  RestorationOverflow,
  buildRestoration,
} from '../../src/web/compaction-restoration.ts'

type Row = { type: string; [key: string]: unknown }
const eventsOf = (rows: Row[]): SessionEvent[] => rows.map((row, index) => ({ seq: index + 1, timestamp: index, ...row })) as unknown as SessionEvent[]

/** A tool call + its successful result, as the log records them. */
function used(rows: Row[], name: string, args: Record<string, unknown>, output = 'ok', ok = true): void {
  const id = `c${rows.length}`
  rows.push({ type: 'assistant/message', stepId: `s${id}`, content: '', toolCalls: [{ id, name, args }] })
  rows.push({ type: 'tool/call', stepId: `s${id}`, call: { id, name, args } })
  rows.push({ type: 'tool/result', stepId: `s${id}`, callId: id, ok, output })
}

const open: Row[] = [{ type: 'turn/start', turnId: 't' }, { type: 'user/message', turnId: 't', content: 'work' }]
const closed: Row[] = [{ type: 'turn/end', turnId: 't', reason: 'completed' }]
const tokens = (text: string): number => Math.ceil(text.length / 4)

let home: string
let project: string
let outside: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'restore-'))
  project = path.join(home, 'project')
  outside = path.join(home, 'outside')
  await fs.mkdir(project)
  await fs.mkdir(outside)
})
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

const run = (rows: Row[], over: { deniedRoots?: string[] } = {}, signal = new AbortController().signal) => {
  const events = eventsOf([...open, ...rows, ...closed])
  return buildRestoration({ events, cutoff: events.at(-1)!.seq, exec: { root: project, ...(over.deniedRoots !== undefined ? { deniedRoots: over.deniedRoots } : {}) }, signal })
}

describe('buildRestoration', () => {
  it('has nothing to restore when the conversation used no restorable state', async () => {
    expect(await run([])).toBeUndefined()
  })

  it('restores the latest task list, because the summary cannot be trusted to carry it exactly', async () => {
    const rows: Row[] = []
    used(rows, 'TodoWrite', { todos: [{ content: 'OBSOLETE ITEM', status: 'pending', activeForm: 'Obsoleting' }] })
    used(rows, 'TodoWrite', { todos: [{ content: 'Ship the fix', status: 'in_progress', activeForm: 'Shipping' }, { content: 'Write docs', status: 'pending', activeForm: 'Writing' }] })
    const restored = (await run(rows))!
    expect(restored.text).toContain('Ship the fix')
    expect(restored.text).toContain('Write docs')
    expect(restored.text).not.toContain('OBSOLETE ITEM')
    expect(restored.sections).toContainEqual(expect.objectContaining({ kind: 'todo', status: 'included' }))
  })

  it('reports agents and background processes that were still running at the cutoff, and not the ones that finished', async () => {
    const rows: Row[] = [
      { type: 'agent/child-spawn', childSessionId: 'child-live', parentTurnId: 't', definition: 'explorer', objective: 'map the module' },
      { type: 'agent/child-spawn', childSessionId: 'child-done', parentTurnId: 't', definition: 'reviewer' },
      { type: 'agent/child-result', childSessionId: 'child-done', parentTurnId: 't', status: 'completed' },
      { type: 'process/start', processId: 'p-live', command: 'pnpm dev', cwd: project },
      { type: 'process/start', processId: 'p-done', command: 'pnpm build', cwd: project },
      { type: 'process/exit', processId: 'p-done', exitCode: 0, termination: 'exited', durationMs: 5 },
    ]
    const restored = (await run(rows))!
    expect(restored.text).toContain('child-live')
    expect(restored.text).toContain('map the module')
    expect(restored.text).toContain('pnpm dev')
    expect(restored.text).not.toContain('child-done')
    expect(restored.text).not.toContain('pnpm build')
  })

  it('reads the CURRENT content of a file the conversation touched, not what the log remembers', async () => {
    await fs.writeFile(path.join(project, 'a.ts'), 'export const value = 2\n')
    const rows: Row[] = []
    used(rows, 'Read', { path: 'a.ts' }, 'export const value = 1')
    const restored = (await run(rows))!
    expect(restored.text).toContain('export const value = 2')
    expect(restored.text).not.toContain('export const value = 1')
    expect(restored.sections).toContainEqual(expect.objectContaining({ kind: 'file', name: 'a.ts', status: 'included' }))
  })

  it('restores at most 5 files, the most recently used first', async () => {
    const rows: Row[] = []
    for (let i = 0; i < RESTORATION_MAX_FILES + 2; i++) {
      await fs.writeFile(path.join(project, `f${i}.ts`), `content-${i}`)
      used(rows, i % 2 === 0 ? 'Read' : 'Edit', { path: `f${i}.ts` })
    }
    const files = (await run(rows))!.sections.filter((section) => section.kind === 'file')
    expect(files.map((section) => section.name)).toEqual(['f6.ts', 'f5.ts', 'f4.ts', 'f3.ts', 'f2.ts'])
  })

  it('a file over the 5k-token cap becomes a path reference with no content (spec §10)', async () => {
    await fs.writeFile(path.join(project, 'big.ts'), `BIGCONTENT${'x'.repeat(RESTORATION_FILE_TOKENS * 4)}`)
    await fs.writeFile(path.join(project, 'edge.ts'), 'e'.repeat(RESTORATION_FILE_TOKENS * 4))
    const rows: Row[] = []
    used(rows, 'Read', { path: 'big.ts' })
    used(rows, 'Read', { path: 'edge.ts' })
    const restored = (await run(rows))!
    expect(restored.sections).toContainEqual(expect.objectContaining({ kind: 'file', name: 'big.ts', status: 'reference' }))
    // Exactly at the cap still fits.
    expect(restored.sections).toContainEqual(expect.objectContaining({ kind: 'file', name: 'edge.ts', status: 'included' }))
    expect(restored.text).toContain('big.ts')
    expect(restored.text).not.toContain('BIGCONTENT')
  })

  it('keeps the file total inside 20k tokens: the files that do not fit become path references without content', async () => {
    const rows: Row[] = []
    for (let i = 0; i < RESTORATION_MAX_FILES; i++) {
      await fs.writeFile(path.join(project, `big${i}.ts`), `${i}`.repeat(RESTORATION_FILE_TOKENS * 4))
      used(rows, 'Read', { path: `big${i}.ts` })
    }
    const restored = (await run(rows))!
    const files = restored.sections.filter((s) => s.kind === 'file')
    expect(files.reduce((sum, s) => sum + (s.status === 'included' || s.status === 'truncated' ? s.tokens : 0), 0)).toBeLessThanOrEqual(RESTORATION_FILES_TOTAL_TOKENS)
    expect(files.filter((s) => s.status === 'reference')).toHaveLength(1)
    expect(restored.text).toContain('big0.ts')
  })

  it('never returns a file outside the current grants, a denied one, or one reached through a link', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET')
    await fs.mkdir(path.join(project, 'private'))
    await fs.writeFile(path.join(project, 'private', 'keys.txt'), 'DENIED CONTENT')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(project, 'link.txt'))
    const rows: Row[] = []
    used(rows, 'Read', { path: path.join(outside, 'secret.txt') })
    used(rows, 'Read', { path: 'private/keys.txt' })
    used(rows, 'Read', { path: 'link.txt' })
    const restored = (await run(rows, { deniedRoots: [path.join(project, 'private')] }))!
    expect(restored.text).not.toContain('TOP SECRET')
    expect(restored.text).not.toContain('DENIED CONTENT')
    const files = restored.sections.filter((s) => s.kind === 'file')
    expect(files).toHaveLength(3)
    expect(files.every((s) => s.status === 'denied')).toBe(true)
  })

  it('a session with no folder grant reads no file at all, not even relative to the process directory', async () => {
    await fs.writeFile(path.join(project, 'a.ts'), 'SHOULD NOT BE READ')
    const rows: Row[] = []
    used(rows, 'Read', { path: path.join(project, 'a.ts') })
    used(rows, 'TodoWrite', { todos: [{ content: 'still restored', status: 'pending', activeForm: 'Restoring' }] })
    const events = eventsOf([...open, ...rows, ...closed])
    const restored = (await buildRestoration({ events, cutoff: events.at(-1)!.seq, exec: undefined, signal: new AbortController().signal }))!
    expect(restored.text).not.toContain('SHOULD NOT BE READ')
    expect(restored.text).toContain('still restored')
    expect(restored.sections).toContainEqual(expect.objectContaining({ kind: 'file', status: 'denied' }))
  })

  it('a file that no longer exists is reported as missing, not restored from memory', async () => {
    const rows: Row[] = []
    used(rows, 'Read', { path: 'gone.ts' }, 'old content that must not come back')
    const restored = (await run(rows))!
    expect(restored.text).not.toContain('old content that must not come back')
    expect(restored.sections).toContainEqual(expect.objectContaining({ kind: 'file', name: 'gone.ts', status: 'missing' }))
  })

  it('skips a file whose tool call failed: the model never saw it', async () => {
    await fs.writeFile(path.join(project, 'a.ts'), 'content')
    const rows: Row[] = []
    used(rows, 'Read', { path: 'a.ts' }, 'denied', false)
    expect(await run(rows)).toBeUndefined()
  })

  it('does not restore a binary file as text', async () => {
    await fs.writeFile(path.join(project, 'img.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x00]))
    const rows: Row[] = []
    used(rows, 'Read', { path: 'img.bin' })
    const restored = (await run(rows))!
    expect(restored.sections).toContainEqual(expect.objectContaining({ kind: 'file', status: 'reference' }))
  })

  it('restores the latest copy of each loaded skill, each cut to 5k tokens', async () => {
    const rows: Row[] = []
    used(rows, 'Skill', { name: 'review' }, 'OLD review body')
    used(rows, 'Skill', { name: 'review' }, 'NEW review body')
    used(rows, 'Skill', { name: 'long' }, 'y'.repeat(RESTORATION_SKILL_TOKENS * 4 * 2))
    used(rows, 'Skill', { action: 'catalog' }, 'a catalog, not a skill')
    const restored = (await run(rows))!
    expect(restored.text).toContain('NEW review body')
    expect(restored.text).not.toContain('OLD review body')
    expect(restored.text).not.toContain('a catalog, not a skill')
    const long = restored.sections.find((s) => s.name === 'long')!
    expect(long.status).toBe('truncated')
    expect(long.tokens).toBeLessThanOrEqual(RESTORATION_SKILL_TOKENS)
  })

  it('stays under the aggregate 25k cap and gives the task list priority over skills and files', async () => {
    const rows: Row[] = []
    used(rows, 'TodoWrite', { todos: [{ content: 'MUST SURVIVE', status: 'in_progress', activeForm: 'Surviving' }] })
    for (let i = 0; i < 7; i++) used(rows, 'Skill', { name: `skill-${i}` }, `${i}`.repeat(RESTORATION_SKILL_TOKENS * 4))
    for (let i = 0; i < RESTORATION_MAX_FILES; i++) {
      await fs.writeFile(path.join(project, `f${i}.ts`), `${i}`.repeat(RESTORATION_FILE_TOKENS * 4))
      used(rows, 'Read', { path: `f${i}.ts` })
    }
    const restored = (await run(rows))!
    expect(restored.tokens).toBeLessThanOrEqual(RESTORATION_TOTAL_TOKENS)
    expect(tokens(restored.text)).toBeLessThanOrEqual(RESTORATION_TOTAL_TOKENS)
    expect(restored.text).toContain('MUST SURVIVE')
    const skillTokens = restored.sections.filter((s) => s.kind === 'skill' && s.status !== 'reference').reduce((sum, s) => sum + s.tokens, 0)
    expect(skillTokens).toBeLessThanOrEqual(RESTORATION_SKILLS_TOTAL_TOKENS)
  })

  it('refuses rather than shorten required state that cannot fit', async () => {
    const rows: Row[] = []
    const todos = Array.from({ length: 100 }, (_, i) => ({ content: `${i}`.repeat(1_200), status: 'pending', activeForm: 'Working' }))
    used(rows, 'TodoWrite', { todos })
    await expect(run(rows)).rejects.toBeInstanceOf(RestorationOverflow)
  })

  it('stops reading when the operation is cancelled', async () => {
    await fs.writeFile(path.join(project, 'a.ts'), 'content')
    const rows: Row[] = []
    used(rows, 'Read', { path: 'a.ts' })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(run(rows, {}, controller.signal)).rejects.toThrow(/cancelled/)
  })

  it('ignores state that happened after the cutoff: the tail is already verbatim', async () => {
    const rows: Row[] = []
    used(rows, 'TodoWrite', { todos: [{ content: 'in tail', status: 'pending', activeForm: 'Tailing' }] })
    const events = eventsOf([...open, ...closed, ...rows])
    const restored = await buildRestoration({ events, cutoff: 3, exec: { root: project }, signal: new AbortController().signal })
    expect(restored).toBeUndefined()
  })
})
