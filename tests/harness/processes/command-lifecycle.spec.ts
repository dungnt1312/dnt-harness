import { afterEach, describe, expect, it } from 'vitest'
import { bashTool } from '../../../src/capabilities/shell/bash.ts'
import { bashOutputTool } from '../../../src/capabilities/shell/background-tools.ts'
import { ProcessRegistry } from '../../../src/harness/processes/registry.ts'
import { DEFAULT_LIMITS } from '../../../src/harness/limits.ts'

const registries: ProcessRegistry[] = []
const registry = () => { const r = new ProcessRegistry(); registries.push(r); return r }
const exec = { root: process.cwd(), sessionId: 'owner' as never }
afterEach(async () => { await Promise.all(registries.splice(0).map(r => r.disposeAll())) })
const idOf = (text: string) => { const id = /id=(proc_[\w-]+)/.exec(text)?.[1]; if (!id) throw new Error(text); return id }

describe('managed command lifecycle', () => {
  it('uses ZCode wait and child background defaults', () => {
    expect(DEFAULT_LIMITS.toolTimeoutMs).toBe(120_000)
    expect(DEFAULT_LIMITS.bashMaxWaitMs).toBe(600_000)
    expect(DEFAULT_LIMITS.subagentBackgroundBashMaxMs).toBe(3_600_000)
  })
  it('auto-background preserves the single execution and later exit', async () => {
    const r = registry()
    const result = await bashTool({ processes: r, timeoutMs: 30 }).execute({ command: 'echo once; sleep 0.3; echo done' }, exec)
    const id = idOf(result)
    expect(r.isRunning(exec.sessionId, id)).toBe(true)
    const output = await bashOutputTool({ processes: r }).execute({ processId: id, block: true, timeoutMs: 5000 }, exec)
    expect(output).toContain('exit code: 0')
    expect(output.match(/once/g)).toHaveLength(1)
    expect(output).toContain('done')
  })
  it('watch timeout does not kill and a foreign session cannot watch', async () => {
    const r = registry()
    const id = idOf(await bashTool({ processes: r }).execute({ command: 'sleep 5', run_in_background: true }, exec))
    const output = await bashOutputTool({ processes: r }).execute({ processId: id, block: true, timeoutMs: 10 }, exec)
    expect(output).toContain('status: running')
    expect(r.isRunning(exec.sessionId, id)).toBe(true)
    expect(await r.wait('foreign' as never, id, { timeoutMs: 10 })).toBeUndefined()
  })
  it('child background maximum kills the execution and emits one terminal event', async () => {
    let exits = 0
    const r = new ProcessRegistry({ onExit: () => { exits++ } }); registries.push(r)
    const id = idOf(await bashTool({ processes: r }).execute({ command: 'sleep 5', run_in_background: true }, { ...exec, subagentBackgroundBashMaxMs: 30 }))
    const output = await bashOutputTool({ processes: r }).execute({ processId: id, block: true, timeoutMs: 5000 }, exec)
    expect(output).toContain('status: killed')
    expect(exits).toBe(1)
  })
  it('sleep retains the foreground deadline', async () => {
    const r = registry()
    expect(await bashTool({ processes: r, timeoutMs: 30 }).execute({ command: 'sleep 5' }, exec)).toContain('terminated by timeout')
  })
  it('sleep with environment assignments retains the foreground deadline', async () => {
    const r = registry()
    expect(await bashTool({ processes: r, timeoutMs: 30 }).execute({ command: 'FOO=bar sleep 5' }, exec)).toContain('terminated by timeout')
    expect(await bashTool({ processes: r, timeoutMs: 30 }).execute({ command: 'FOO=bar BAZ=qux sleep 5' }, exec)).toContain('terminated by timeout')
  })
})

it('watch abort leaves background alive while foreground abort kills', async () => {
  const r = registry()
  const id = idOf(await bashTool({ processes: r }).execute({ command: 'sleep 5', run_in_background: true }, exec))
  const controller = new AbortController()
  controller.abort()
  expect(await bashOutputTool({ processes: r }).execute({ processId: id, block: true }, { ...exec, signal: controller.signal })).toContain('status: running')
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 30)
  expect(await bashTool({ processes: r }).execute({ command: 'sleep 5' }, { ...exec, signal: stop.signal })).toContain('terminated by stop')
  expect(r.isRunning(exec.sessionId, id)).toBe(true)
})

it('root background has no child maximum and foreign kill cannot stop it', async () => {
  const r = registry()
  const id = idOf(await bashTool({ processes: r }).execute({ command: 'sleep 5', run_in_background: true }, exec))
  expect(await r.kill('foreign' as never, id)).toMatchObject({ outcome: 'not-found' })
  await r.wait(exec.sessionId, id, { timeoutMs: 80 })
  expect(r.isRunning(exec.sessionId, id)).toBe(true)
})

it('foreground root exit does not turn a held pipe into a retained background tree', async () => {
  const r = registry()
  const result = await bashTool({ processes: r, timeoutMs: 80 }).execute({ command: 'sleep 5 & exit 0' }, exec)
  expect(result).toContain('exit code: 0')
  expect(r.runningCount(exec.sessionId)).toBe(0)
})

it('ended records prune after the retention window; running records never do', async () => {
  const r = new ProcessRegistry({}, { endedRetentionMs: 50 }); registries.push(r)
  const endedId = idOf(await bashTool({ processes: r }).execute({ command: 'echo short-lived', run_in_background: true }, exec))
  await r.wait(exec.sessionId, endedId, { timeoutMs: 5000 })
  const runningId = idOf(await bashTool({ processes: r }).execute({ command: 'sleep 5', run_in_background: true }, exec))
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(r.read(exec.sessionId, endedId)).toBeUndefined()
  expect(r.read(exec.sessionId, runningId)).toBeDefined()
  expect(r.isRunning(exec.sessionId, runningId)).toBe(true)
})

it('an ended record inside the retention window stays readable through every lookup', async () => {
  const r = new ProcessRegistry({}, { endedRetentionMs: 60_000 }); registries.push(r)
  const id = idOf(await bashTool({ processes: r }).execute({ command: 'echo still-readable', run_in_background: true }, exec))
  await r.wait(exec.sessionId, id, { timeoutMs: 5000 })
  expect(r.read(exec.sessionId, id)?.status).toBe('exited')
  expect(r.detail(exec.sessionId, id)).toBeDefined()
  expect(r.snapshot(exec.sessionId).map((row) => row.id)).toContain(id)
})

it('capacity is denied before any second command is spawned', async () => {
  const r = new ProcessRegistry({}, { perSession: 1 }); registries.push(r)
  await bashTool({ processes: r }).execute({ command: 'sleep 5', run_in_background: true }, exec)
  // Foreground rejection must not execute this command at all.
  expect(r.canRegister(exec.sessionId)).toMatchObject({ ok: false })
})
