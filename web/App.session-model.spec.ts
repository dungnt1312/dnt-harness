import { describe, expect, it } from 'vitest'
import { ModelDefaultsCoordinator, SessionModelMutationQueue, composerSkillRows, sessionEffectiveControls, sessionModelKey } from './App.tsx'

describe('composer skill catalog scope', () => {
  it('loads the catalog for the bound project so disabled source rules and project layers match context assembly', async () => {
    const list = async (workspaceId: string, projectId?: string) => [{
      name: `${workspaceId}:${projectId ?? 'workspace'}`,
      title: 'skill',
      description: '',
      source: 'workspace' as const,
      hash: 'h',
    }]

    await expect(composerSkillRows(list, 'ws-1', 'project-1')).resolves.toMatchObject([{ name: 'ws-1:project-1' }])
    await expect(composerSkillRows(list, 'ws-1', null)).resolves.toMatchObject([{ name: 'ws-1:workspace' }])
  })
})

describe('per-session model cache coordination', () => {
  it('uses workspace plus session as the cache address', () => {
    expect(sessionModelKey('A', 'one')).not.toBe(sessionModelKey('B', 'one'))
    expect(sessionModelKey('A', 'one')).not.toBe(sessionModelKey('A', 'two'))
  })

  it('does not use workspace defaults for an unresolved or explicitly-blank session', () => {
    const workspace = { provider: 'workspace-provider', model: 'workspace-model', thinkingLevel: 'high' }
    expect(sessionEffectiveControls('one', workspace, { status: 'loading' })).toEqual({ provider: null, model: null, thinkingLevel: null })
    expect(sessionEffectiveControls('one', workspace, { status: 'error', error: 'offline' })).toEqual({ provider: null, model: null, thinkingLevel: null })
    expect(sessionEffectiveControls('one', workspace, { status: 'ready', model: { provider: null, model: null, thinkingLevel: null, source: 'session' } })).toEqual({ provider: null, model: null, thinkingLevel: null })
    expect(sessionEffectiveControls(null, workspace, undefined)).toEqual(workspace)
  })

  it('derives cached legacy controls from the current global default', () => {
    const cachedLegacy = { status: 'ready' as const, model: { provider: 'old-provider', model: 'old-model', thinkingLevel: 'low', source: 'global' as const } }
    const changedDefaults = { provider: 'new-provider', model: 'new-model', thinkingLevel: 'high' }
    expect(sessionEffectiveControls('legacy', changedDefaults, cachedLegacy)).toEqual(changedDefaults)
  })

  it('fences draft session creation until a pending global default write settles', async () => {
    const states: string[] = []
    const coordinator = new ModelDefaultsCoordinator((state) => states.push(state.status))
    let release!: () => void
    const saved = coordinator.enqueue(async () => new Promise<void>((resolve) => { release = resolve }).then(() => ({ provider: 'p', model: 'm', thinkingLevel: null })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(coordinator.isPending()).toBe(true)
    release()
    await saved
    expect(coordinator.isPending()).toBe(false)
    expect(states).toEqual(['ready'])
  })

  it('discards a delayed GET after a mutation and preserves the newest pair for thinking', async () => {
    const states: { status: string; defaults?: { provider: string | null; model: string | null; thinkingLevel: string | null } }[] = []
    const coordinator = new ModelDefaultsCoordinator((state) => states.push(state.status === 'ready' ? { status: state.status, defaults: state.defaults } : { status: state.status }))
    let resolveGet!: (defaults: { provider: string; model: string; thinkingLevel: null }) => void
    const loading = coordinator.refresh(() => new Promise((resolve) => { resolveGet = resolve }))
    await coordinator.enqueue(async () => ({ provider: 'new', model: 'new-model', thinkingLevel: null }))
    resolveGet({ provider: 'stale', model: 'stale-model', thinkingLevel: null })
    await loading
    await coordinator.enqueue(async (defaults) => ({ ...defaults!, thinkingLevel: 'high' }))
    expect(states.at(-1)).toEqual({ status: 'ready', defaults: { provider: 'new', model: 'new-model', thinkingLevel: 'high' } })
  })

  it('publishes an error state for a failed global-default GET and recovers on retry', async () => {
    const states: string[] = []
    const coordinator = new ModelDefaultsCoordinator((state) => states.push(state.status))
    await coordinator.refresh(async () => { throw new Error('offline') })
    await coordinator.refresh(async () => ({ provider: 'p', model: 'm', thinkingLevel: null }))
    expect(states).toEqual(['loading', 'error', 'loading', 'ready'])
  })

  it('feeds a queued successor the last confirmed pair, never an explicit blank, after a failed write', async () => {
    const coordinator = new ModelDefaultsCoordinator(() => {})
    await coordinator.refresh(async () => ({ provider: 'p', model: 'm', thinkingLevel: null }))
    await expect(coordinator.enqueue(async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    // A rejected PUT is defined by the server as not published: the last
    // confirmed pair is still what the server runs, so the queued thinking
    // write must carry it — never {provider:null, model:null}.
    const writes: unknown[] = []
    const thinking = coordinator.enqueue(async (current) => {
      writes.push(current)
      return { ...current!, thinkingLevel: 'high' }
    })
    await expect(thinking).resolves.toEqual({ provider: 'p', model: 'm', thinkingLevel: 'high' })
    expect(writes).toEqual([{ provider: 'p', model: 'm', thinkingLevel: null }])
  })

  it('serializes model and thinking partial writes in call order', async () => {
    const queue = new SessionModelMutationQueue()
    const started: string[] = []
    let finishModel!: () => void
    const model = queue.enqueue('A:one', async () => {
      started.push('model')
      await new Promise<void>((resolve) => { finishModel = resolve })
      return 'model saved'
    })
    const thinking = queue.enqueue('A:one', async () => {
      started.push('thinking')
      return 'thinking saved'
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['model'])
    finishModel()
    await expect(model).resolves.toBe('model saved')
    await expect(thinking).resolves.toBe('thinking saved')
    expect(started).toEqual(['model', 'thinking'])
  })

  it('keeps a session pending until its entire write queue settles', async () => {
    const counts: number[] = []
    const queue = new SessionModelMutationQueue((_key, count) => counts.push(count))
    let finishFirst!: () => void
    const first = queue.enqueue('A:one', async () => new Promise<void>((resolve) => { finishFirst = resolve }))
    const second = queue.enqueue('A:one', async () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const send = (): boolean => !queue.isPending('A:one')
    expect(send()).toBe(false)
    finishFirst()
    await first
    // The first PUT has returned, but its queued successor still fences send.
    expect(send()).toBe(false)
    await second
    expect(send()).toBe(true)
    expect(queue.isPending('A:one')).toBe(false)
    expect(counts).toEqual([1, 2, 1, 0])
  })

  it('does not block writes for a different conversation', async () => {
    const queue = new SessionModelMutationQueue()
    const started: string[] = []
    let finishA!: () => void
    const a = queue.enqueue('A:one', async () => {
      started.push('A')
      await new Promise<void>((resolve) => { finishA = resolve })
    })
    const b = queue.enqueue('A:two', async () => { started.push('B') })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['A', 'B'])
    finishA()
    await Promise.all([a, b])
  })
})
