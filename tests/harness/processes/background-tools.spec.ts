import { describe, expect, it } from 'vitest'
import { bashTool } from '../../../src/capabilities/shell/bash.ts'
import { bashOutputTool, killShellTool } from '../../../src/capabilities/shell/background-tools.ts'
import { ProcessRegistry } from '../../../src/harness/processes/registry.ts'
import type { ToolExecution } from '../../../src/harness/tools/types.ts'

const exec = (sessionId: string): ToolExecution => ({ root: process.cwd(), sessionId: sessionId as never })

async function startBackground(registry: ProcessRegistry, command: string, sessionId = 's1'): Promise<string> {
  const tool = bashTool({ processes: registry })
  const result = await tool.execute({ command, run_in_background: true }, exec(sessionId))
  const id = /id=(proc_[0-9a-f-]+)/.exec(result)?.[1]
  if (id === undefined) throw new Error(result)
  return id
}

describe('BashOutput', () => {
  it('reads captured output and status while running, then the final exit', async () => {
    const registry = new ProcessRegistry({})
    const output = bashOutputTool({ processes: registry })
    const id = await startBackground(registry, 'echo out-from-bg')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const running = await output.execute({ processId: id }, exec('s1'))
    expect(running).toContain('[status: running]')
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const done = await output.execute({ processId: id }, exec('s1'))
    expect(done).toContain('out-from-bg')
    expect(done).toContain('exit code: 0')
  }, 15_000)

  it('errors with the known id list on an unknown process', async () => {
    const registry = new ProcessRegistry({})
    const output = bashOutputTool({ processes: registry })
    const id = await startBackground(registry, 'sleep 5')
    const result = await output.execute({ processId: 'proc_missing' }, exec('s1'))
    expect(result).toContain('unknown processId')
    expect(result).toContain(id)
    await registry.kill('s1' as never, id)
  }, 15_000)

  it('rejects bad arguments and session-less calls', async () => {
    const registry = new ProcessRegistry({})
    const output = bashOutputTool({ processes: registry })
    expect(await output.execute({}, exec('s1'))).toContain("argument 'processId'")
    expect(await output.execute({ processId: 'proc_x' }, { root: process.cwd() })).toContain('error: no session')
  })
})

describe('KillShell', () => {
  it('kills a running process and confirms', async () => {
    const registry = new ProcessRegistry({})
    const kill = killShellTool({ processes: registry })
    const id = await startBackground(registry, 'sleep 30')
    const result = await kill.execute({ processId: id }, exec('s1'))
    expect(result).toContain('killed')
    expect(registry.isRunning('s1' as never, id)).toBe(false)
  }, 15_000)

  it('reports already-ended truthfully and unknown ids with the list', async () => {
    const registry = new ProcessRegistry({})
    const killTool = killShellTool({ processes: registry })
    const id = await startBackground(registry, 'true')
    // Poll instead of a fixed sleep: a login shell can take seconds to exit on a loaded Windows host.
    const deadline = Date.now() + 10_000
    while (registry.isRunning('s1' as never, id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(registry.isRunning('s1' as never, id)).toBe(false)
    const ended = await killTool.execute({ processId: id }, exec('s1'))
    expect(ended).toContain('already ended')
    const unknown = await killTool.execute({ processId: 'proc_missing' }, exec('s1'))
    expect(unknown).toContain('unknown processId')
  }, 15_000)
})
