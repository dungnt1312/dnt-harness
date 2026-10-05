import { afterEach, expect, it } from 'vitest'
import { bashTool } from '../../../src/capabilities/shell/bash.ts'
import { ProcessRegistry } from '../../../src/harness/processes/registry.ts'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
const registries: ProcessRegistry[] = []
const registry = () => { const r = new ProcessRegistry(); registries.push(r); return r }
const exec = { root: process.cwd(), sessionId: 'review' as never }
afterEach(async () => { await Promise.all(registries.splice(0).map(r => r.disposeAll())) })
it('reports model-visible output truncation', async () => {
  const result = await bashTool({ processes: registry() }).execute({ command: "printf '12345678901234567890'" }, { ...exec, outputLimit: 10 })
  expect(result).toContain('truncated 10 chars')
})
it('compatibility requested wait exceeds default up to maximum', async () => {
  const result = await bashTool({ timeoutMs: 20, maxWaitMs: 1000 }).execute({ command: 'sleep 0.1; echo finished', timeoutMs: 500 }, { root: process.cwd() })
  expect(result).toContain('finished')
  expect(result).toContain('exit code: 0')
})
it('shutdown fence rejects subsequent commands without spawning', async () => {
  const r = registry(); r.closeAdmission()
  expect(await bashTool({ processes: r }).execute({ command: 'echo must-not-run' }, exec)).toContain('shutting down')
  expect(r.snapshot(exec.sessionId)).toHaveLength(0)
})
it('root exit drain keeps real exit outcome when foreground wait expires', async () => {
  const r = registry()
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  const admitted = r.tryRegister({ sessionId: exec.sessionId, command: 'fixture', cwd: exec.root, child, executable: '/bin/bash', treeTag: 'fixture' })
  if (!admitted.ok) throw new Error(admitted.error)
  child.emit('exit', 0)
  await r.wait(exec.sessionId, admitted.record.id, { timeoutMs: 1 })
  expect(r.isDraining(exec.sessionId, admitted.record.id)).toBe(true)
  await r.wait(exec.sessionId, admitted.record.id, { timeoutMs: 100 })
  expect(r.read(exec.sessionId, admitted.record.id)).toMatchObject({ status: 'exited', exitCode: 0 })
})
it('managed stop output obeys visible limit', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  const result = await bashTool({ processes: registry() }).execute({ command: "printf '12345678901234567890'; sleep 5" }, { ...exec, outputLimit: 10, signal: controller.signal })
  expect(result).toContain('truncated 10 chars')
  expect(result).not.toContain('12345678901234567890')
  expect(result).toContain('terminated by stop')
})
