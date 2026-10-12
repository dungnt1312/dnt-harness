/** BackgroundHooks: caps, rewake window, kill — with real hook processes. */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BACKGROUND_HOOKS_PER_ROOT, BackgroundHooks, REWAKE_CAP, REWAKE_WINDOW_MS, type RewakeDelivery } from '../../src/web/background-hooks.ts'
import type { ResolvedHook } from '../../src/harness/hooks/settings.ts'
import type { Session } from '../../src/harness/session/session.ts'

const fixture = fileURLToPath(new URL('../fixtures/hook-command.mjs', import.meta.url))
const cmd = (...args: string[]): string => `"${process.execPath}" "${fixture}" ${args.map((arg) => `"${arg}"`).join(' ')}`

/** An `asyncRewake` hook, or a plain `async` one when `rewake` is false. */
function hook(id: string, command: string, rewake = true): ResolvedHook {
  return { id, event: 'PostToolUse', matcher: 'Bash', command, layer: 'workspace', source: 'test', active: true, supported: true, timeout: 10, ...(rewake ? { asyncRewake: true as const } : { async: true as const }) }
}

/** A session stand-in that records what the registry appends (the real one needs a store). */
function recorder(): { session: Session; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = []
  const session = { poisoned: false, append: (event: Record<string, unknown>) => { events.push(event); return event }, durable: async () => {} } as unknown as Session
  return { session, events }
}

async function settle(registry: BackgroundHooks, root = 'root'): Promise<void> {
  const deadline = Date.now() + 10_000
  while (registry.size(root) > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
}

describe('BackgroundHooks', () => {
  it('caps rewakes per conversation within the window, then allows them again', async () => {
    let now = 1_000_000
    const delivered: RewakeDelivery[] = []
    const { session, events } = recorder()
    const registry = new BackgroundHooks({ sessionOf: () => session, deliverRewake: async (delivery) => { delivered.push(delivery); return true } }, () => now)
    const launch = (index: number) => registry.launch({ event: 'PostToolUse', hook: hook(`h${index}`, cmd('rewake', '0', `finding ${index}`)), input: {}, options: {}, sessionId: 'root', rootSessionId: 'root' })
    for (let index = 0; index < REWAKE_CAP + 1; index++) { launch(index); await settle(registry) }
    expect(delivered).toHaveLength(REWAKE_CAP)
    expect(events.map((event) => event['rewake'])).toEqual([...Array(REWAKE_CAP).fill('woke'), 'capped'])
    expect(delivered[0]).toMatchObject({ rootSessionId: 'root', summary: 'Stop hook feedback' })
    now += REWAKE_WINDOW_MS
    launch(99)
    await settle(registry)
    expect(delivered).toHaveLength(REWAKE_CAP + 1)
  }, 30_000)

  it('refuses launches over the per-conversation cap and audits them; killRoot ends the rest', async () => {
    const { session, events } = recorder()
    const registry = new BackgroundHooks({ sessionOf: () => session, deliverRewake: async () => true })
    const started: boolean[] = []
    for (let index = 0; index <= BACKGROUND_HOOKS_PER_ROOT; index++) {
      started.push(registry.launch({ event: 'Stop', hook: hook(`s${index}`, cmd('hang'), false), input: {}, options: {}, sessionId: 'root', rootSessionId: 'root' }))
    }
    expect(started.filter(Boolean)).toHaveLength(BACKGROUND_HOOKS_PER_ROOT)
    expect(events).toEqual([expect.objectContaining({ decision: 'skipped:cap', background: true })])
    // Another conversation is not affected by this one's cap.
    expect(registry.launch({ event: 'Stop', hook: hook('other', cmd('allow'), false), input: {}, options: {}, sessionId: 'other', rootSessionId: 'other' })).toBe(true)
    expect(await registry.killRoot('root')).toBe(BACKGROUND_HOOKS_PER_ROOT)
    expect(registry.size('root')).toBe(0)
    expect(events.filter((event) => event['decision'] === 'killed')).toHaveLength(BACKGROUND_HOOKS_PER_ROOT)
    await registry.closeAll()
    // Closed: nothing new starts.
    expect(registry.launch({ event: 'Stop', hook: hook('late', cmd('allow'), false), input: {}, options: {}, sessionId: 'root', rootSessionId: 'root' })).toBe(false)
  }, 30_000)

  it('a killed rewake hook never wakes the model', async () => {
    const delivered: RewakeDelivery[] = []
    const { session } = recorder()
    const registry = new BackgroundHooks({ sessionOf: () => session, deliverRewake: async (delivery) => { delivered.push(delivery); return true } })
    registry.launch({ event: 'Stop', hook: hook('k', cmd('rewake', '1500', 'late')), input: {}, options: {}, sessionId: 'root', rootSessionId: 'root' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await registry.killRoot('root')
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    expect(delivered).toHaveLength(0)
  }, 20_000)
})
