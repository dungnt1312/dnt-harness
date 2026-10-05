import { describe, expect, it } from 'vitest'
import { Kernel } from '../../src/kernel/registry.ts'
import { SessionsService } from '../../src/harness/session/service.ts'
import { ToolsService } from '../../src/harness/tools/service.ts'
import { AgentsService } from '../../src/harness/agent/service.ts'
import { approvalCallFingerprint, attachApproval, createApprovalReceiptRegistry } from '../../src/harness/approval/policy.ts'
import { attachDangerousCommandGuard, guardMatchFingerprint } from '../../src/harness/guard/guard.ts'
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

const DANGEROUS = 'git reset --hard HEAD~1'

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

  it.each([
    ['safe to deny', 'echo harmless', 'rm -rf /', false, false],
    ['safe to ask', 'echo harmless', 'git reset --hard HEAD~1', true, true],
    ['dangerous to safe', 'rm -rf /', 'echo rewritten-safe', false, true],
  ] as const)('evaluates the finalized Bash command after a later-registered rewrite: %s', async (_label, original, rewritten, shouldAsk, shouldRun) => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    const executed: string[] = []
    kernel.ctx.tools.register({
      ...bashTool,
      async execute(args) {
        const command = String(args['command'])
        executed.push(command)
        return `ran: ${command}`
      },
    })
    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => DEFAULT_CONFIG })
    let asks = 0
    attachApproval(kernel.ctx, {
      policy: { Bash: 'allow' },
      forceAsk: (call, scope) => guard.getMatch(call, scope.executionId)?.action === 'ask',
      askUser: async () => { asks += 1; return true },
    })
    // Real registration order: guard attaches first, rewrite hook arrives later.
    kernel.ctx.on('tools/rewrite', async (payload, next) => next({
      call: { ...payload.call, args: { ...payload.call.args, command: rewritten } },
      exec: payload.exec,
    }))

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(bashCall(original))
    })
    expect(asks).toBe(shouldAsk ? 1 : 0)
    expect(result?.ok).toBe(shouldRun)
    expect(executed).toEqual(shouldRun ? [rewritten] : [])
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

  it('a stale ask match cannot survive invalidation: re-evaluating without a match, or with unavailable config, drops all evidence', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    let source: () => DangerousCommandsConfig = () => DEFAULT_CONFIG
    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => source() })
    const call = bashCall(DANGEROUS)
    const exec = { root: '', executionId: 'exec-1' } as never

    const asked = await guard.evaluate(call, 'ws', exec)
    expect(asked.match?.action).toBe('ask')
    // Presentation evidence is reachable by call identity and by execution.
    expect(guard.getMatch(call)?.action).toBe('ask')
    expect(guard.getMatch(call, 'exec-1')?.action).toBe('ask')

    // Config invalidated to "no longer matches": the old match must not linger.
    source = () => ({ ...DEFAULT_CONFIG, presets: { ...DEFAULT_CONFIG.presets, gitDestructive: 'off' } })
    expect((await guard.evaluate(call, 'ws', exec)).match).toBeNull()
    expect(guard.getMatch(call)).toBeNull()
    expect(guard.getMatch(call, 'exec-1')).toBeNull()

    // Re-arm, then make the config unavailable: evaluation fails closed AND clears.
    source = () => DEFAULT_CONFIG
    await guard.evaluate(call, 'ws', exec)
    expect(guard.getMatch(call)?.action).toBe('ask')
    source = () => { throw new Error('config offline') }
    await expect(guard.evaluate(call, 'ws', exec)).rejects.toThrow(/fail-closed/)
    expect(guard.getMatch(call)).toBeNull()
    expect(guard.getMatch(call, 'exec-1')).toBeNull()
    await kernel.stop()
  })

  it('the ask requirement is scoped to the matched rule: unrelated edits keep a receipt valid, edits to the matched rule invalidate it', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    let config: DangerousCommandsConfig = DEFAULT_CONFIG
    const guard = attachDangerousCommandGuard(kernel.ctx, { configSource: () => config })
    const registry = createApprovalReceiptRegistry()
    const call = bashCall(DANGEROUS)
    const scope = {
      sessionId: 's1' as never, rootSessionId: 's1' as never, turnId: undefined,
      executionId: 'exec-1' as never, workspaceId: 'ws',
    }
    const requirementOf = async (): Promise<{ kind: 'dangerous-command'; subjectFingerprint: string; version?: string | number }> => {
      const evaluation = await guard.evaluate(call, 'ws', { root: '', executionId: 'exec-1' } as never)
      expect(evaluation.match?.action).toBe('ask')
      return { kind: 'dangerous-command', subjectFingerprint: guardMatchFingerprint(evaluation.match!) }
    }

    const shown = await requirementOf()
    registry.issue(call, scope, [shown])
    expect(registry.receiptFor(call, scope)?.callFingerprint).toBe(approvalCallFingerprint(call))

    // Unrelated preset edit: the whole-config hash changes, the matched rule does not.
    const before = (await guard.evaluate(call, 'ws', { root: '', executionId: 'exec-1' } as never)).hash
    config = { ...DEFAULT_CONFIG, presets: { ...DEFAULT_CONFIG.presets, dbDestructive: 'off' } }
    expect((await guard.evaluate(call, 'ws', { root: '', executionId: 'exec-1' } as never)).hash).not.toBe(before)
    expect(registry.covers(call, scope, [await requirementOf()])).toBe(true)

    // An unrelated custom rule appended: still the same matched preset.
    config = { ...config, customRules: [{ id: 'cr-x', pattern: 'unrelated-thing', isRegex: false, action: 'deny' }] }
    expect(registry.covers(call, scope, [await requirementOf()])).toBe(true)

    // A custom rule that now claims the command (custom rules match first) is a different identity.
    config = { ...config, customRules: [{ id: 'cr-claim', pattern: 'git reset', isRegex: false, action: 'ask' }] }
    expect(registry.covers(call, scope, [await requirementOf()])).toBe(false)

    // Same custom rule id, edited pattern that still matches: identity changes.
    registry.issue(call, scope, [await requirementOf()])
    config = { ...config, customRules: [{ id: 'cr-claim', pattern: 'git reset --hard', isRegex: false, action: 'ask' }] }
    expect(registry.covers(call, scope, [await requirementOf()])).toBe(false)
    await kernel.stop()
  })
})
