import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { ProcessRegistry, type ProcessRecord } from '../../../src/harness/processes/registry.ts'

const SHELL = process.platform === 'win32' ? 'bash' : '/bin/sh'

/** A child that stays alive until killed; resolves on close. */
function spawnSleeper(): { child: ChildProcess; closed: Promise<void> } {
  const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'sleep 30'] : ['-c', 'sleep 30'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  return { child, closed }
}

function fakeSession(id: string): never {
  return id as never
}

describe('ProcessRegistry', () => {
  it('registers, exposes a snapshot, and finalizes on natural exit with termination exited', async () => {
    const exits: ProcessRecord[] = []
    const registry = new ProcessRegistry({ onExit: (record) => exits.push({ ...record }) })
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'echo hi'] : ['-c', 'echo hi'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'echo hi', cwd: process.cwd(), child, executable: SHELL, treeTag: 'tag-1' })
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) throw new Error('unreachable')
    expect(registry.isRunning(fakeSession('s1'), admitted.record.id)).toBe(true)
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(exits.at(-1)?.status).toBe('exited')
    expect(exits.at(-1)?.exitCode).toBe(0)
    expect(registry.read(fakeSession('s1'), admitted.record.id)?.output).toContain('hi')
  })

  it('kill() tree-kills and reports termination killed', async () => {
    const exits: ProcessRecord[] = []
    const registry = new ProcessRegistry({ onExit: (record) => exits.push({ ...record }) })
    const { child, closed } = spawnSleeper()
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: 'tag-2' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    const outcome = await registry.kill(fakeSession('s1'), admitted.record.id)
    expect(outcome).toEqual({ outcome: 'killed' })
    await closed
    expect(exits.at(-1)?.status).toBe('killed')
  })

  it('kill on an ended process is already-ended, unknown id is not-found', async () => {
    const registry = new ProcessRegistry({})
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'true'] : ['-c', 'true'], { detached: true, stdio: 'ignore' })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'true', cwd: process.cwd(), child, executable: SHELL, treeTag: 'tag-3' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const ended = await registry.kill(fakeSession('s1'), admitted.record.id)
    expect(ended).toEqual({ outcome: 'already-ended', status: 'exited' })
    expect(await registry.kill(fakeSession('s1'), 'proc_missing')).toEqual({ outcome: 'not-found' })
  })

  it('enforces the per-session cap of 8 then rejects with an actionable error', () => {
    const registry = new ProcessRegistry({}, { perSession: 8, host: 24 })
    const kids: ChildProcess[] = []
    for (let i = 0; i < 8; i += 1) {
      const { child } = spawnSleeper()
      kids.push(child)
      expect(registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: `t-${i}` }).ok).toBe(true)
    }
    const ninth = spawnSleeper()
    const rejected = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child: ninth.child, executable: SHELL, treeTag: 't-9' })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('unreachable')
    expect(rejected.error).toContain('8')
    ninth.child.kill()
    for (const kid of kids) kid.kill()
    void registry.disposeAll()
  })

  it('enforces the host cap across sessions', () => {
    const registry = new ProcessRegistry({}, { perSession: 8, host: 2 })
    for (const session of ['s1', 's2']) {
      const { child } = spawnSleeper()
      expect(registry.tryRegister({ sessionId: fakeSession(session), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: `h-${session}` }).ok).toBe(true)
    }
    const third = spawnSleeper()
    const rejected = registry.tryRegister({ sessionId: fakeSession('s3'), command: 'sleep 30', cwd: process.cwd(), child: third.child, executable: SHELL, treeTag: 'h-3' })
    expect(rejected.ok).toBe(false)
    third.child.kill()
    void registry.disposeAll()
  })

  it('stops capturing output at the ring cap and marks truncation', async () => {
    const registry = new ProcessRegistry({}, { ringChars: 100 })
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'seq 1 200'] : ['-c', 'seq 1 200'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'seq 1 200', cwd: process.cwd(), child, executable: SHELL, treeTag: 't-cap' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const read = registry.read(fakeSession('s1'), admitted.record.id)
    expect(read?.output.length).toBeLessThanOrEqual(100)
    expect(read?.outputTruncated).toBe(true)
  })

  it('dispose kills running processes of the session and emits no exit callback', async () => {
    const exits: ProcessRecord[] = []
    const registry = new ProcessRegistry({ onExit: (record) => exits.push({ ...record }) })
    const { child, closed } = spawnSleeper()
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'sleep 30', cwd: process.cwd(), child, executable: SHELL, treeTag: 't-d' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await registry.dispose(fakeSession('s1'))
    await closed
    expect(exits).toHaveLength(0)
    expect(registry.runningCount(fakeSession('s1'))).toBe(0)
  })

  it('snapshot exposes derived durationMs and the ended shape', async () => {
    const registry = new ProcessRegistry({})
    const child = spawn(SHELL, process.platform === 'win32' ? ['-lc', 'true'] : ['-c', 'true'], { detached: true, stdio: 'ignore' })
    const admitted = registry.tryRegister({ sessionId: fakeSession('s1'), command: 'true', cwd: process.cwd(), child, executable: SHELL, treeTag: 't-s' })
    if (!admitted.ok) throw new Error(String(admitted.error))
    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const rows = registry.snapshot(fakeSession('s1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('exited')
    expect(typeof rows[0]?.durationMs).toBe('number')
  })
})
