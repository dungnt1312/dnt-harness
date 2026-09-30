import { describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/registry.ts'
import { SessionsService } from '../../src/harness/session/service.ts'
import { ToolsService } from '../../src/harness/tools/service.ts'
import { AgentsService } from '../../src/harness/agent/service.ts'
import { attachApproval } from '../../src/harness/approval/policy.ts'
import { attachDangerousCommandGuard } from '../../src/harness/guard/guard.ts'
import { DEFAULT_CONFIG } from '../../src/harness/guard/defaults.ts'
import type { DangerousCommandsConfig } from '../../src/harness/guard/types.ts'
import type { ToolCall } from '../../src/harness/llm/types.ts'
import type { ToolDefinition } from '../../src/harness/tools/types.ts'
import { agentScope } from '../../src/harness/agent/scope.ts'

const bashTool: ToolDefinition = {
  name: 'Bash',
  description: 'run bash',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  async execute(args: Record<string, unknown>) {
    return `ran: ${String(args['command'])}`
  },
}

const readTool: ToolDefinition = {
  name: 'Read',
  description: 'read file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async execute(args: Record<string, unknown>) {
    return `read: ${String(args['path'])}`
  },
}

function bashCall(command: string, id = 'call-1'): ToolCall {
  return { id, name: 'Bash', args: { command } }
}

describe('guard pipeline', () => {
  it('deny blocks before approval (askUser never called)', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(bashTool)

    let askCalled = false
    attachDangerousCommandGuard(kernel.ctx, { configSource: () => DEFAULT_CONFIG })
    attachApproval(kernel.ctx, {
      policy: { Bash: 'allow' },
      askUser: async () => {
        askCalled = true
        return true
      },
    })

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(bashCall('rm -rf /'))
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/Dangerous Commands/)
    expect(askCalled).toBe(false)
    await kernel.stop()
  })

  it('ask forces approval even when mode allow', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(bashTool)

    let askCalled = false
    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => DEFAULT_CONFIG })
    attachApproval(kernel.ctx, {
      policy: { Bash: 'allow' },
      forceAsk: (call) => guard.getMatch(call)?.action === 'ask',
      askUser: async () => {
        askCalled = true
        return true
      },
    })

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(bashCall('git reset --hard HEAD~1'))
    })
    // DEFAULT gitDestructive is ask, so should have forced ask and then allowed after user allows
    expect(askCalled).toBe(true)
    expect(result?.ok).toBe(true)
    await kernel.stop()
  })

  it('allow custom exempts (custom allow overrides preset deny)', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(bashTool)

    const config: DangerousCommandsConfig = {
      v: 1,
      presets: { ...DEFAULT_CONFIG.presets },
      customRules: [{ id: 'cr-1', pattern: 'rm -rf ./tmp', isRegex: false, action: 'allow' }],
    }
    let askCalled = false
    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => config })
    attachApproval(kernel.ctx, {
      policy: { Bash: 'allow' },
      forceAsk: (call) => guard.getMatch(call)?.action === 'ask',
      askUser: async () => {
        askCalled = true
        return true
      },
    })

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(bashCall('rm -rf ./tmp'))
    })
    expect(result?.ok).toBe(true)
    expect(askCalled).toBe(false)
    await kernel.stop()
  })

  it('mode deny still wins over guard allow', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(bashTool)

    const config: DangerousCommandsConfig = {
      v: 1,
      presets: { ...DEFAULT_CONFIG.presets },
      customRules: [{ id: 'cr-1', pattern: 'rm -rf ./tmp', isRegex: false, action: 'allow' }],
    }
    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => config })
    attachApproval(kernel.ctx, {
      policy: { Bash: 'deny' },
      forceAsk: (call) => guard.getMatch(call)?.action === 'ask',
      askUser: async () => true,
    })

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(bashCall('rm -rf ./tmp'))
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/policy denies/)
    await kernel.stop()
  })

  it('non-Bash passes through unaffected', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(readTool)

    let askCalled = false
    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => DEFAULT_CONFIG })
    attachApproval(kernel.ctx, {
      policy: { Read: 'allow' },
      forceAsk: (call) => guard.getMatch(call)?.action === 'ask',
      askUser: async () => {
        askCalled = true
        return true
      },
    })

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute({ id: 'r1', name: 'Read', args: { path: 'rm -rf /' } })
    })
    expect(result?.ok).toBe(true)
    expect(result?.output).toBe('read: rm -rf /')
    expect(askCalled).toBe(false)
    await kernel.stop()
  })

  it('guard fail-closed on matcher throw denies', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(bashTool)

    // Config with invalid shape that causes matcher to throw (null presets)
    const badConfig = { v: 1, presets: null, customRules: [] } as unknown as DangerousCommandsConfig
    attachDangerousCommandGuard(kernel.ctx, { configSource: () => badConfig })
    attachApproval(kernel.ctx, { policy: { Bash: 'allow' }, askUser: async () => true })

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(bashCall('echo hi'))
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/Dangerous Commands/)
    await kernel.stop()
  })

  it('an ask match never leaks to another execution reusing the model call id', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(bashTool)

    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => DEFAULT_CONFIG })
    const asked: string[] = []
    attachApproval(kernel.ctx, {
      policy: { Bash: 'allow' },
      forceAsk: (call, scope) => guard.getMatch(call, scope.executionId)?.action === 'ask',
      askUser: async (call) => {
        asked.push(String(call.args['command']))
        return true
      },
    })

    await agentScope.run({ sessionId: session.id }, async () => {
      // Both calls carry model call id 'c1' — as two roots easily would.
      await (await kernel.ctx.tools.prepare(bashCall('git reset --hard HEAD~1', 'c1'))).execute()
      const innocent = await (await kernel.ctx.tools.prepare(bashCall('echo harmless', 'c1'))).execute()
      expect(innocent.output).toBe('ran: echo harmless')
    })
    // Only the dangerous command asked; the innocent one inherited nothing.
    expect(asked).toEqual(['git reset --hard HEAD~1'])
    await kernel.stop()
  })
})
