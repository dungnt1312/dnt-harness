import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Kernel } from '../../src/kernel/registry.ts'
import { DEFAULT_LIMITS } from '../../src/harness/limits.ts'
import { LIMIT_FIELDS, WEB_LIMIT_DEFAULTS } from '../../src/harness/limits-config.ts'
import { AppConfigStore, canonicalHash } from '../../src/harness/config/store.ts'
import { AppConfigService } from '../../src/harness/config/service.ts'
import { readLimits } from '../../src/harness/config/limits-reader.ts'
import { AppConfigError, type AppConfigDocument, type LimitEdit, type LimitsSnapshot } from '../../src/harness/config/types.ts'

const FILE = '/virtual/app-config.json'
const EMPTY_HASH = canonicalHash({ v: 1 })

/** In-memory io seam: one virtual file, counted writes, optional read gate and write failure. */
class MemoryIo {
  content: string | undefined
  writes = 0
  failWrite: Error | undefined
  failRead: Error | undefined
  /** When set, the next read awaits this promise before returning. */
  readGate: Promise<void> | undefined
  onRead: (() => void) | undefined

  constructor(initial?: unknown) {
    if (initial !== undefined) this.content = typeof initial === 'string' ? initial : JSON.stringify(initial)
  }

  read = async (_file: string): Promise<string> => {
    this.onRead?.()
    const gate = this.readGate
    if (gate) {
      this.readGate = undefined
      await gate
    }
    if (this.failRead) throw this.failRead
    if (this.content === undefined) throw Object.assign(new Error('ENOENT: missing'), { code: 'ENOENT' })
    return this.content
  }

  write = async (_file: string, content: string): Promise<void> => {
    if (this.failWrite) throw this.failWrite
    this.writes++
    this.content = content
  }

  get document(): unknown {
    return this.content === undefined ? undefined : JSON.parse(this.content)
  }
}

function setup(initial?: unknown, options?: ConstructorParameters<typeof AppConfigService>[1]) {
  const io = new MemoryIo(initial)
  const store = new AppConfigStore(FILE, { read: io.read, write: io.write })
  const service = new AppConfigService(store, options)
  return { io, store, service }
}

function hashOf(document: AppConfigDocument): string {
  return canonicalHash(document)
}

async function rejection(promise: Promise<unknown>): Promise<AppConfigError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppConfigError)
    return error as AppConfigError
  }
  throw new Error('expected rejection')
}

function field(view: Awaited<ReturnType<AppConfigService['describe']>>, key: string) {
  const found = view.fields.find(f => f.key === key)
  if (!found) throw new Error(`missing field ${key}`)
  return found
}

describe('AppConfigService', () => {
  it('composes library, host, file and explicit layers at revision 0', async () => {
    const { service } = setup(
      { v: 1, limits: { streamIdleMs: 123 } },
      { hostDefaults: WEB_LIMIT_DEFAULTS, explicit: { toolOutputLimit: 77 } },
    )
    await service.boot()
    expect(service.read().values).toMatchObject({ streamIdleMs: 123, automaticCompactionPressure: 0.85, toolOutputLimit: 77 })
    expect(service.read().values.toolTimeoutMs).toBe(DEFAULT_LIMITS.toolTimeoutMs)
    expect(service.read().revision).toBe(0)

    const view = await service.describe()
    expect(field(view, 'streamIdleMs')).toMatchObject({ source: 'file', locked: false, fileValue: 123, shadowed: false })
    expect(field(view, 'automaticCompactionPressure')).toMatchObject({ source: 'host', locked: false, shadowed: false })
    expect(field(view, 'toolOutputLimit')).toMatchObject({ source: 'explicit', locked: true, shadowed: false })
    expect(field(view, 'toolTimeoutMs')).toMatchObject({ source: 'library', locked: false, shadowed: false })
    expect(field(view, 'toolTimeoutMs').fileValue).toBeUndefined()
    // Inherited = library + host only: what unsetting a file override falls back to.
    expect(view.inherited).toEqual({ ...DEFAULT_LIMITS, automaticCompactionPressure: 0.85 })
    expect(view.fields.map(f => f.key)).toEqual(LIMIT_FIELDS.map(f => f.key))
    expect(field(view, 'streamIdleMs').label).toBe(LIMIT_FIELDS.find(f => f.key === 'streamIdleMs')?.label)
  })

  it('invalid explicit values fall through without locking or shadowing the file', async () => {
    const { service } = setup({ v: 1, limits: { streamIdleMs: 123 } }, { explicit: { streamIdleMs: 0, toolOutputLimit: Number.NaN } })
    await service.boot()
    expect(service.read().values.streamIdleMs).toBe(123)
    expect(service.read().values.toolOutputLimit).toBe(DEFAULT_LIMITS.toolOutputLimit)
    const view = await service.describe()
    expect(field(view, 'streamIdleMs')).toMatchObject({ source: 'file', locked: false, shadowed: false, fileValue: 123 })
    expect(field(view, 'toolOutputLimit')).toMatchObject({ source: 'library', locked: false })
    const edited = await service.edit([{ op: 'set', key: 'streamIdleMs', value: 456 }], view.hash ?? '')
    expect(edited.active.values.streamIdleMs).toBe(456)
  })

  it('reports a valid file override hidden by an explicit lock as shadowed', async () => {
    const { service } = setup({ v: 1, limits: { toolOutputLimit: 500 } }, { explicit: { toolOutputLimit: 77 } })
    await service.boot()
    expect(service.read().values.toolOutputLimit).toBe(77)
    const view = await service.describe()
    expect(field(view, 'toolOutputLimit')).toMatchObject({ source: 'explicit', locked: true, fileValue: 500, shadowed: true })
  })

  it('snapshot_is_detached_frozen_and_stable_until_update', async () => {
    const { service } = setup()
    await service.boot()
    const first = service.read()
    expect(service.read()).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.values)).toBe(true)
    expect(first.values).not.toBe(DEFAULT_LIMITS)
    expect(() => {
      ;(first.values as { toolOutputLimit: number }).toolOutputLimit = 1
    }).toThrow(TypeError)
    expect(DEFAULT_LIMITS.toolOutputLimit).toBe(60_000)

    const view = await service.edit([{ op: 'set', key: 'toolOutputLimit', value: 1234 }], EMPTY_HASH)
    const second = service.read()
    expect(second).not.toBe(first)
    expect(second.revision).toBe(1)
    expect(second.values.toolOutputLimit).toBe(1234)
    expect(first.values.toolOutputLimit).toBe(60_000)
    expect(first.revision).toBe(0)
    expect(view.active).toBe(second)
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.document)).toBe(true)
    expect(Object.isFrozen(view.document?.limits)).toBe(true)
  })

  it('set_only_persists_changed_field', async () => {
    const { io, service } = setup({ v: 1, limits: { streamIdleMs: 123 } }, { hostDefaults: WEB_LIMIT_DEFAULTS })
    await service.boot()
    const { hash } = await service.describe()
    const view = await service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }], hash ?? '')
    expect(io.document).toEqual({ v: 1, limits: { streamIdleMs: 123, toolTimeoutMs: 300_000 } })
    expect(view.document).toEqual({ v: 1, limits: { streamIdleMs: 123, toolTimeoutMs: 300_000 } })
    expect(view.hash).toBe(hashOf({ v: 1, limits: { streamIdleMs: 123, toolTimeoutMs: 300_000 } }))
    expect(view.outOfSync).toBe(false)
    expect(view.active.values).toMatchObject({ streamIdleMs: 123, toolTimeoutMs: 300_000, automaticCompactionPressure: 0.85 })
  })

  it('unset_inherits_without_pinning_other_defaults', async () => {
    const initial = { v: 1, limits: { streamIdleMs: 123, automaticCompactionPressure: 0.5 } } as const
    const { io, service } = setup(initial, { hostDefaults: WEB_LIMIT_DEFAULTS })
    await service.boot()
    expect(service.read().values.automaticCompactionPressure).toBe(0.5)
    const view = await service.edit([{ op: 'unset', key: 'automaticCompactionPressure' }], hashOf(initial))
    expect(io.document).toEqual({ v: 1, limits: { streamIdleMs: 123 } })
    expect(view.active.values.automaticCompactionPressure).toBe(0.85)
    expect(field(view, 'automaticCompactionPressure')).toMatchObject({ source: 'host' })
    expect(field(view, 'automaticCompactionPressure').fileValue).toBeUndefined()

    const cleared = await service.edit([{ op: 'unset', key: 'streamIdleMs' }], view.hash ?? '')
    // Removing the last override leaves the bare document, not copied defaults.
    expect(io.document).toEqual({ v: 1 })
    expect(cleared.hash).toBe(EMPTY_HASH)
    expect(cleared.active.values.streamIdleMs).toBe(DEFAULT_LIMITS.streamIdleMs)
  })

  it('locked_set_and_unset_refuse_before_write', async () => {
    const { io, service } = setup({ v: 1, limits: { toolOutputLimit: 500 } }, { explicit: { toolOutputLimit: 77 } })
    await service.boot()
    const before = service.read()
    const hash = hashOf({ v: 1, limits: { toolOutputLimit: 500 } })
    for (const edit of [{ op: 'set', key: 'toolOutputLimit', value: 99 }, { op: 'unset', key: 'toolOutputLimit' }] as const) {
      const error = await rejection(service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }, edit], hash))
      expect(error.code).toBe('locked')
      expect(error.key).toBe('toolOutputLimit')
    }
    expect(io.writes).toBe(0)
    expect(service.read()).toBe(before)
    // Unrelated fields stay editable.
    await service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }], hash)
    expect(io.document).toEqual({ v: 1, limits: { toolOutputLimit: 500, toolTimeoutMs: 5 } })
  })

  it('whole_batch_is_rejected_if_one_edit_invalid', async () => {
    const { io, service } = setup()
    await service.boot()
    const before = service.read()
    const bad: unknown[] = [
      [{ op: 'set', key: 'toolTimeoutMs', value: 5 }, { op: 'set', key: 'streamIdleMs', value: 1.5 }],
      [{ op: 'set', key: 'toolTimeoutMs', value: 5 }, { op: 'set', key: 'maxSubagents', value: 4 }],
      [{ op: 'set', key: 'toolTimeoutMs', value: 5 }, { op: 'drop', key: 'streamIdleMs' }],
      [{ op: 'set', key: 'toolTimeoutMs', value: 5 }, { op: 'set', key: 'stepRetries', value: 0 }],
      [{ op: 'set', key: 'toolTimeoutMs', value: '5' }],
      [{ op: 'unset', key: 'toolTimeoutMs', value: 5 }],
      [{ op: 'set', key: 'toolTimeoutMs', value: 5 }, { op: 'unset', key: 'toolTimeoutMs' }],
      [null],
      'not-an-array',
      [],
    ]
    for (const edits of bad) {
      const error = await rejection(service.edit(edits as readonly LimitEdit[], EMPTY_HASH))
      expect(error.code).toBe('invalid')
    }
    const hashError = await rejection(service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }], 42 as unknown as string))
    expect(hashError.code).toBe('invalid')
    expect(io.writes).toBe(0)
    expect(io.content).toBeUndefined()
    expect(service.read()).toBe(before)
  })

  it('stale expected hash conflicts without writing or publishing', async () => {
    const { io, service } = setup({ v: 1, limits: { streamIdleMs: 123 } })
    await service.boot()
    const before = service.read()
    const error = await rejection(service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }], EMPTY_HASH))
    expect(error.code).toBe('conflict')
    expect(io.writes).toBe(0)
    expect(service.read()).toBe(before)
  })

  it('edit refuses a document the caller never observed even if the file reverts before save', async () => {
    const observed = { v: 1, limits: { streamIdleMs: 123 } } as const
    const { io, service } = setup(observed)
    await service.boot()
    const before = service.read()
    // The edit's read sees a concurrent manual change; by the store's
    // re-read the file is back to what the caller observed.
    const manual = JSON.stringify({ v: 1, limits: { streamIdleMs: 999 } })
    const original = io.content
    let reads = 0
    io.onRead = () => {
      reads++
      io.content = reads === 1 ? manual : original
    }
    const error = await rejection(service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }], hashOf(observed)))
    expect(error.code).toBe('conflict')
    expect(io.writes).toBe(0)
    expect(service.read()).toBe(before)
  })

  it('noop_and_source_only_edit_do_not_increment_revision', async () => {
    const published: LimitsSnapshot[] = []
    const { io, service } = setup(undefined, { hostDefaults: WEB_LIMIT_DEFAULTS, onPublished: s => published.push(s) })
    await service.boot()
    const before = service.read()
    // Same value as the host default: source moves host -> file, value stays.
    const pinned = await service.edit([{ op: 'set', key: 'automaticCompactionPressure', value: 0.85 }], EMPTY_HASH)
    expect(io.document).toEqual({ v: 1, limits: { automaticCompactionPressure: 0.85 } })
    expect(service.read()).toBe(before)
    expect(pinned.active.revision).toBe(0)
    expect(field(pinned, 'automaticCompactionPressure').source).toBe('file')
    expect(pinned.hash).toBe(hashOf({ v: 1, limits: { automaticCompactionPressure: 0.85 } }))
    // Removing the redundant override changes the hash but not the values.
    const removed = await service.edit([{ op: 'unset', key: 'automaticCompactionPressure' }], pinned.hash ?? '')
    expect(removed.hash).toBe(EMPTY_HASH)
    expect(field(removed, 'automaticCompactionPressure').source).toBe('host')
    expect(service.read()).toBe(before)
    // An empty batch is refused rather than rewriting the operator's file.
    const writes = io.writes
    const empty = await rejection(service.edit([], EMPTY_HASH))
    expect(empty.code).toBe('invalid')
    expect(empty.message).toMatch(/must not be empty/)
    expect(io.writes).toBe(writes)
    expect(service.read()).toBe(before)
    expect(published).toEqual([])
  })

  it('write_failure_preserves_active_identity', async () => {
    const { io, service } = setup()
    await service.boot()
    const before = service.read()
    io.failWrite = new Error('disk full')
    const error = await rejection(service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }], EMPTY_HASH))
    expect(error.code).toBe('io')
    expect(service.read()).toBe(before)
    const view = await service.describe()
    expect(view.hash).toBe(EMPTY_HASH)
    expect(view.outOfSync).toBe(false)
    expect(field(view, 'toolTimeoutMs').source).toBe('library')
  })

  it('notification_throw_does_not_reject_committed_edit', async () => {
    const reported: unknown[] = []
    const boom = new Error('listener failed')
    const { io, service } = setup(undefined, {
      onPublished: () => {
        throw boom
      },
      onNotificationError: error => reported.push(error),
    })
    await service.boot()
    const view = await service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }], EMPTY_HASH)
    expect(view.active.revision).toBe(1)
    expect(service.read().values.toolTimeoutMs).toBe(5)
    expect(io.document).toEqual({ v: 1, limits: { toolTimeoutMs: 5 } })
    expect(reported).toEqual([boom])

    // A throwing error handler is contained as well.
    const quiet = setup(undefined, {
      onPublished: () => {
        throw boom
      },
      onNotificationError: () => {
        throw new Error('handler failed')
      },
    })
    await quiet.service.boot()
    await expect(quiet.service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 6 }], EMPTY_HASH)).resolves.toMatchObject({ active: { revision: 1 } })
  })

  it('publishes each changed snapshot once to onPublished', async () => {
    const published: LimitsSnapshot[] = []
    const { service } = setup(undefined, { onPublished: s => published.push(s) })
    await service.boot()
    expect(published).toEqual([])
    await service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 5 }], EMPTY_HASH)
    expect(published).toEqual([service.read()])
  })

  it('manual_edit_describe_does_not_activate', async () => {
    const { io, service } = setup()
    await service.boot()
    const before = service.read()
    io.content = JSON.stringify({ limits: { toolTimeoutMs: 42 }, v: 1 }, null, 2)
    const view = await service.describe()
    expect(service.read()).toBe(before)
    expect(view.active).toBe(before)
    expect(view.outOfSync).toBe(true)
    expect(view.document).toEqual({ v: 1, limits: { toolTimeoutMs: 42 } })
    expect(view.hash).toBe(hashOf({ v: 1, limits: { toolTimeoutMs: 42 } }))
    expect(field(view, 'toolTimeoutMs')).toMatchObject({ source: 'library', fileValue: 42 })

    // Explicit reload activates the manual edit.
    const reloaded = await service.reload()
    expect(reloaded.active.revision).toBe(1)
    expect(reloaded.active.values.toolTimeoutMs).toBe(42)
    expect(reloaded.outOfSync).toBe(false)
    expect(field(reloaded, 'toolTimeoutMs').source).toBe('file')
    // Reloading unchanged content is a no-op.
    const again = await service.reload()
    expect(again.active).toBe(reloaded.active)
    expect(io.writes).toBe(0)
  })

  it('a save based on the observed file activates its complete candidate, including manual edits', async () => {
    const { io, service } = setup()
    await service.boot()
    io.content = JSON.stringify({ v: 1, limits: { toolTimeoutMs: 42 } })
    const observed = await service.describe()
    const view = await service.edit([{ op: 'set', key: 'streamIdleMs', value: 7 }], observed.hash ?? '')
    expect(view.active.values).toMatchObject({ toolTimeoutMs: 42, streamIdleMs: 7 })
    expect(view.active.revision).toBe(1)
    expect(view.outOfSync).toBe(false)
  })

  it('reload_error_preserves_last_good', async () => {
    const { io, service } = setup({ v: 1, limits: { toolTimeoutMs: 42 } })
    await service.boot()
    const before = service.read()
    io.content = '{ broken'
    const error = await rejection(service.reload())
    expect(error.code).toBe('invalid')
    expect(service.read()).toBe(before)
    const view = await service.describe()
    expect(view.document).toBeNull()
    expect(view.hash).toBeNull()
    expect(view.error).toMatch(/not valid JSON/)
    expect(view.active).toBe(before)
    expect(field(view, 'toolTimeoutMs')).toMatchObject({ source: 'file', shadowed: false })
    expect(field(view, 'toolTimeoutMs').fileValue).toBeUndefined()

    io.content = undefined
    io.failRead = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const ioError = await rejection(service.reload())
    expect(ioError.code).toBe('io')
    expect(service.read()).toBe(before)
  })

  it('boot_invalid_refuses', async () => {
    const { service } = setup({ v: 1, limits: { streamIdleMs: 1.5 } })
    const error = await rejection(service.boot())
    expect(error.code).toBe('invalid')
    expect(() => service.read()).toThrow(/not booted/)

    const unreadable = setup()
    unreadable.io.failRead = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    expect((await rejection(unreadable.service.boot())).code).toBe('io')
  })

  it('missing_reload_removes_file_overrides', async () => {
    const { io, service } = setup({ v: 1, limits: { toolTimeoutMs: 42 } }, { hostDefaults: WEB_LIMIT_DEFAULTS })
    await service.boot()
    io.content = undefined
    const view = await service.reload()
    expect(view.active.revision).toBe(1)
    expect(view.active.values).toEqual({ ...DEFAULT_LIMITS, automaticCompactionPressure: 0.85 })
    expect(view.document).toEqual({ v: 1 })
    expect(view.hash).toBe(EMPTY_HASH)
    expect(view.outOfSync).toBe(false)
    expect(io.content).toBeUndefined()
  })

  it('slow_reload_then_edit_is_serialized', async () => {
    const { io, service } = setup({ v: 1, limits: { toolTimeoutMs: 42 } })
    await service.boot()
    // Operator edits the file; a reload starts reading it and stalls.
    io.content = JSON.stringify({ v: 1, limits: { toolTimeoutMs: 43 } })
    let release!: () => void
    io.readGate = new Promise<void>(resolve => {
      release = resolve
    })
    let reads = 0
    io.onRead = () => reads++
    const reload = service.reload()
    const edit = service.edit([{ op: 'set', key: 'streamIdleMs', value: 7 }], hashOf({ v: 1, limits: { toolTimeoutMs: 43 } }))
    // Give the edit every chance to run ahead of the stalled reload.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reads).toBe(1)
    expect(io.writes).toBe(0)
    release()
    const reloaded = await reload
    const edited = await edit
    expect(reloaded.active.revision).toBe(1)
    expect(reloaded.active.values.toolTimeoutMs).toBe(43)
    expect(edited.active.revision).toBe(2)
    expect(service.read()).toBe(edited.active)
    expect(service.read().values).toMatchObject({ toolTimeoutMs: 43, streamIdleMs: 7 })
  })

  it('unknown_future_file_stays_diagnosable_and_edit_refuses', async () => {
    const { io, service } = setup()
    await service.boot()
    const before = service.read()
    const future = JSON.stringify({ v: 2, limits: { toolTimeoutMs: 5 }, plugins: { a: 1 } })
    io.content = future
    const view = await service.describe()
    expect(view.document).toBeNull()
    expect(view.hash).toBeNull()
    expect(view.error).toMatch(/unknown app-config section|unsupported app-config version/)
    expect(view.active).toBe(before)
    const error = await rejection(service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 6 }], EMPTY_HASH))
    expect(error.code).toBe('invalid')
    expect(io.content).toBe(future)
    expect(io.writes).toBe(0)
    expect(service.read()).toBe(before)
  })

  it('operations before boot are refused', async () => {
    const { service } = setup()
    expect(() => service.read()).toThrow(/not booted/)
    await expect(service.describe()).rejects.toThrow(/not booted/)
    await expect(service.reload()).rejects.toThrow(/not booted/)
    await expect(service.edit([], EMPTY_HASH)).rejects.toThrow(/not booted/)
  })

  describe('with a real file', () => {
    let dir: string
    let file: string
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'app-config-service-'))
      file = path.join(dir, 'app-config.json')
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('persists edits and a fresh service restores them at revision 0', async () => {
      await writeFile(file, JSON.stringify({ v: 1, limits: { streamIdleMs: 123 } }))
      const service = new AppConfigService(new AppConfigStore(file))
      await service.boot()
      const { hash } = await service.describe()
      await service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 300_000 }], hash ?? '')
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, limits: { streamIdleMs: 123, toolTimeoutMs: 300_000 } })

      const restarted = new AppConfigService(new AppConfigStore(file))
      await restarted.boot()
      expect(restarted.read().revision).toBe(0)
      expect(restarted.read().values).toMatchObject({ streamIdleMs: 123, toolTimeoutMs: 300_000 })
    })
  })
})

describe('readLimits', () => {
  it('reads the mounted limits reader', async () => {
    const kernel = new Kernel()
    const { service } = setup({ v: 1, limits: { toolTimeoutMs: 42 } })
    await service.boot()
    kernel.ctx.provide('limits', { toolTimeoutMs: 1 })
    kernel.ctx.provide('limits-reader', service)
    expect(readLimits(kernel.ctx)).toBe(service.read())
    await service.edit([{ op: 'set', key: 'toolTimeoutMs', value: 43 }], hashOf({ v: 1, limits: { toolTimeoutMs: 42 } }))
    expect(readLimits(kernel.ctx)).toMatchObject({ revision: 1, values: { toolTimeoutMs: 43 } })
    await kernel.stop()
  })

  it('falls back to the legacy static limits service at revision 0', async () => {
    const kernel = new Kernel()
    kernel.ctx.provide('limits', { toolTimeoutMs: 1234, streamIdleMs: 0 })
    const snapshot = readLimits(kernel.ctx)
    expect(snapshot.revision).toBe(0)
    expect(snapshot.values).toEqual({ ...DEFAULT_LIMITS, toolTimeoutMs: 1234 })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.values)).toBe(true)
    await kernel.stop()

    const bare = new Kernel()
    expect(readLimits(bare.ctx)).toEqual({ revision: 0, values: DEFAULT_LIMITS })
    await bare.stop()
  })
})
