/** G5 command hook fixture contract: block/rewrite/inject/flag/failure/timeout. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isBlockingDecision, isFailureDecision, parseHooksConfig, runHook } from 'dnt-harness'

const fixture = fileURLToPath(new URL('../fixtures/hook-command.mjs', import.meta.url))
const binding = (mode: string, onFailure: 'allow' | 'deny' = 'deny') => ({
  matcher: '*',
  type: 'command' as const,
  command: `${process.execPath} ${fixture} ${mode}`,
  timeoutMs: mode === 'hang' ? 100 : 2_000,
  onFailure,
})

describe('hook config', () => {
  it('strictly validates event/type/failure policy', () => {
    expect(() => parseHooksConfig('{bad')).toThrow(/valid JSON/)
    expect(() => parseHooksConfig(JSON.stringify({ version: 1, hooks: { Nope: [] } }))).toThrow(/unknown hook event/)
    expect(() => parseHooksConfig(JSON.stringify({ version: 1, hooks: { PreToolUse: [{ type: 'http', command: 'x', onFailure: 'deny' }] } }))).toThrow(/command/)
  })
})

describe('command hooks', () => {
  it('exit 2 blocks; exit 0 allows', async () => {
    const blocked = await runHook(binding('block'), { tool: 'Bash', args: {} })
    expect(isBlockingDecision(blocked)).toBe(true)
    expect(blocked.stderr).toContain('blocked by fixture')
    const allowed = await runHook(binding('allow'), { tool: 'Read', args: {} })
    expect(isBlockingDecision(allowed)).toBe(false)
    expect(isFailureDecision(allowed)).toBe(false)
  })

  it('structured stdout rewrites/injects/flags', async () => {
    const rewritten = await runHook(binding('rewrite'), { tool: 'Bash', args: { command: 'safe' } })
    expect(rewritten.updatedInput).toEqual({ command: 'safe', rewritten: true })
    const injected = await runHook(binding('inject'), { prompt: 'hello' })
    expect(injected.injected).toBe('fixture injected context')
    const flagged = await runHook(binding('flag'), { result: 'sk-secret' })
    expect(flagged.flagged).toBe('possible secret')
  })

  it('exit 1 and timeout are failures; caller applies onFailure', async () => {
    expect(isFailureDecision(await runHook(binding('fail', 'allow'), {}))).toBe(true)
    const start = Date.now()
    const timedOut = await runHook(binding('hang', 'deny'), {})
    expect(timedOut.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(3_000)
  }, 10_000)
})
