import { describe, expect, it } from 'vitest'
import { bashTool } from '../../../src/capabilities/shell/bash.ts'
import { ProcessRegistry } from '../../../src/harness/processes/registry.ts'
import type { ToolExecution } from '../../../src/harness/tools/types.ts'

const ECHO_CMD = 'echo bg-marker'

function exec(sessionId: string, root: string): ToolExecution {
  return { root, sessionId: sessionId as never }
}

describe('Bash run_in_background', () => {
  it('returns immediately with a process id and does not wait for exit', async () => {
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry })
    const started = Date.now()
    const result = await tool.execute({ command: 'sleep 5', run_in_background: true }, exec('s1', process.cwd()))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toMatch(/background process started: id=proc_[0-9a-f-]+; read output with BashOutput; kill with KillShell/)
    await registry.disposeAll()
  }, 15_000)

  it('rejects background mode when the host wired no registry or the call has no session', async () => {
    const bare = bashTool({})
    expect(await bare.execute({ command: 'sleep 1', run_in_background: true }, exec('s1', process.cwd()))).toContain('error: background processes are not available')
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry })
    expect(await tool.execute({ command: 'sleep 1', run_in_background: true }, { root: process.cwd() })).toContain('error: background mode requires a session')
  })

  it('registry gains a running record whose output is readable and killable', async () => {
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry })
    const result = await tool.execute({ command: ECHO_CMD, run_in_background: true }, exec('s1', process.cwd()))
    const id = /id=(proc_[0-9a-f-]+)/.exec(result)?.[1]
    expect(id).toBeDefined()
    if (id === undefined) return
    expect(registry.isRunning('s1' as never, id)).toBe(true)
    const outcome = await registry.kill('s1' as never, id)
    expect(outcome).toEqual({ outcome: 'killed' })
  }, 15_000)

  it('foreground behavior is unchanged (no run_in_background arg)', async () => {
    const registry = new ProcessRegistry({})
    const tool = bashTool({ processes: registry, timeoutMs: 10_000 })
    const result = await tool.execute({ command: ECHO_CMD }, exec('s1', process.cwd()))
    expect(result).toContain('bg-marker')
    expect(result).toContain('[exit code: 0]')
  }, 15_000)
})
