/** The kernel fence: a session owns at most one provider request, except for requests that opt into the same sharing scope. */
import { describe, expect, it } from 'vitest'
import { Kernel, LlmService, type LlmProvider, type ModelRequest, type StreamOptions } from 'dnt-harness'

const REQUEST: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] }

/** Every stream stays open until `releaseAll()`. */
function fixture() {
  const kernel = new Kernel()
  kernel.ctx.plugin(LlmService)
  const releases: Array<() => void> = []
  const provider: LlmProvider = {
    name: 'held',
    models: ['held'],
    async *stream() {
      await new Promise<void>((resolve) => { releases.push(resolve) })
      yield { type: 'delta', delta: 'ok' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
  kernel.ctx.llm.register(provider)
  const llm = kernel.ctx.llm
  const options = (sessionId: string, scope?: string): StreamOptions => ({
    attribution: { sessionId, turnId: 'turn', stepId: crypto.randomUUID() },
    ...(scope !== undefined ? { shareSessionOwnership: scope } : {}),
  })
  /** Start a request and wait until its provider stream is open. */
  const open = async (sessionId: string, scope?: string) => {
    const before = releases.length
    const done = (async () => { for await (const _event of llm.stream(REQUEST, options(sessionId, scope))) void _event })()
    const failed = done.then(() => undefined, (error: unknown) => error as Error)
    await Promise.race([failed, new Promise<void>((resolve) => { const t = setInterval(() => { if (releases.length > before) { clearInterval(t); resolve() } }, 1) })])
    return { done, failed }
  }
  const releaseAll = () => { for (const release of releases.splice(0)) release() }
  return { open, releaseAll, kernel }
}

describe('llm session ownership', () => {
  it('rejects a second unscoped request on the same session while the first is open', async () => {
    const { open, releaseAll } = fixture()
    const first = await open('s1')
    const second = await open('s1')
    expect(await second.failed).toMatchObject({ message: 'session retains provider request ownership' })
    releaseAll()
    await first.done
  })

  it('admits requests sharing a scope, and drains the refcount once all end', async () => {
    const { open, releaseAll } = fixture()
    const a = await open('s1', 'fold-1')
    const b = await open('s1', 'fold-1')
    releaseAll()
    await Promise.all([a.done, b.done])
    const third = await open('s1')
    releaseAll()
    await third.done
  })

  it('rejects a different scope or no scope while a scoped request is open', async () => {
    const { open, releaseAll } = fixture()
    const holder = await open('s1', 'fold-1')
    expect(await (await open('s1', 'fold-2')).failed).toMatchObject({ message: 'session retains provider request ownership' })
    expect(await (await open('s1')).failed).toMatchObject({ message: 'session retains provider request ownership' })
    releaseAll()
    await holder.done
  })

  it('rejects a scoped request while an unscoped one is open', async () => {
    const { open, releaseAll } = fixture()
    const holder = await open('s1')
    expect(await (await open('s1', 'fold-1')).failed).toMatchObject({ message: 'session retains provider request ownership' })
    releaseAll()
    await holder.done
  })

  it('never fences a different session', async () => {
    const { open, releaseAll } = fixture()
    const a = await open('s1')
    const b = await open('s2')
    releaseAll()
    await Promise.all([a.done, b.done])
  })
})
