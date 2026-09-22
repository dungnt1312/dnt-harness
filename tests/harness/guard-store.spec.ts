import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DangerousCommandsStore } from '../../src/harness/guard/store.ts'
import { DEFAULT_CONFIG } from '../../src/harness/guard/defaults.ts'

describe('DangerousCommandsStore', () => {
  let dir: string
  let store: DangerousCommandsStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'guard-'))
    store = new DangerousCommandsStore(dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loadGlobal returns DEFAULT_CONFIG when no file exists', async () => {
    const { config } = await store.loadGlobal()
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('inherits global when workspace absent', async () => {
    // save a custom global
    const custom = { v: 1 as const, presets: { ...DEFAULT_CONFIG.presets, fsDestructive: 'off' as const }, customRules: [] }
    await store.saveGlobal(custom)
    const g = await store.loadGlobal()
    const w = await store.load('ws-1')
    expect(w.config).toEqual(g.config)
    expect(w.config.presets.fsDestructive).toBe('off')
  })

  it('load falls back to DEFAULT_CONFIG when both files absent', async () => {
    const { config } = await store.load('ws-unknown')
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('workspace save overrides global', async () => {
    await store.save('ws-1', { v: 1, presets: { fsDestructive: 'off', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] })
    const w = await store.load('ws-1')
    expect(w.config.presets.fsDestructive).toBe('off')
    const g = await store.loadGlobal()
    expect(g.config.presets.fsDestructive).toBe('deny')
  })

  it('global save is visible to new workspace loads', async () => {
    await store.saveGlobal({ v: 1, presets: { fsDestructive: 'off', gitDestructive: 'off', systemPriv: 'off', networkExfil: 'off', dbDestructive: 'off', resourceExhaust: 'off' }, customRules: [] })
    const w = await store.load('ws-new')
    expect(w.config.presets.fsDestructive).toBe('off')
  })

  it('rejects invalid regex', async () => {
    await expect(
      store.save('ws-1', {
        v: 1,
        presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
        customRules: [{ id: 'cr-1', pattern: '[', isRegex: true, action: 'deny' }],
      }),
    ).rejects.toThrow()
  })

  it('rejects invalid regex on saveGlobal', async () => {
    await expect(
      store.saveGlobal({
        v: 1,
        presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
        customRules: [{ id: 'cr-1', pattern: '(unclosed', isRegex: true, action: 'deny' }],
      }),
    ).rejects.toThrow()
  })

  it('conflict on stale hash', async () => {
    const { hash } = await store.save('ws-1', {
      v: 1,
      presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
      customRules: [],
    })
    // stale hash should conflict
    await expect(
      store.save(
        'ws-1',
        { v: 1, presets: { fsDestructive: 'off', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] },
        'stale',
      ),
    ).rejects.toThrow(/conflict/i)
    // correct hash should succeed
    const { hash: hash2 } = await store.save(
      'ws-1',
      { v: 1, presets: { fsDestructive: 'off', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] },
      hash,
    )
    expect(hash2).not.toBe(hash)
  })

  it('conflict on stale hash for global', async () => {
    const { hash } = await store.saveGlobal({
      v: 1,
      presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
      customRules: [],
    })
    await expect(
      store.saveGlobal(
        { v: 1, presets: { fsDestructive: 'off', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] },
        'stale-hash',
      ),
    ).rejects.toThrow(/conflict/i)
    // correct hash succeeds
    await expect(
      store.saveGlobal(
        { v: 1, presets: { fsDestructive: 'off', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] },
        hash,
      ),
    ).resolves.toBeDefined()
  })

  it('corrupt json falls back to default', async () => {
    const wsDir = path.join(dir, 'workspaces', 'ws-corrupt')
    await mkdir(wsDir, { recursive: true })
    await writeFile(path.join(wsDir, 'dangerous-commands.json'), '{ not valid json', 'utf8')
    const { config } = await store.load('ws-corrupt')
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('corrupt global json falls back to default', async () => {
    await writeFile(path.join(dir, 'dangerous-commands.json'), 'corrupt!!!', 'utf8')
    const { config } = await store.loadGlobal()
    expect(config).toEqual(DEFAULT_CONFIG)
    // workspace load also falls back via global
    const w = await store.load('ws-any')
    expect(w.config).toEqual(DEFAULT_CONFIG)
  })

  it('rejects v != 1', async () => {
    await expect(store.save('ws-1', { v: 2 as unknown as 1, presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] })).rejects.toThrow(/v/i)
  })

  it('rejects unknown preset keys', async () => {
    await expect(
      store.save('ws-1', {
        v: 1,
        presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny', unknownPreset: 'deny' } as unknown as Record<string, string> as never,
        customRules: [],
      }),
    ).rejects.toThrow(/preset/i)
  })

  it('rejects invalid preset action', async () => {
    await expect(
      store.save('ws-1', {
        v: 1,
        presets: { fsDestructive: 'allow' as unknown as 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
        customRules: [],
      }),
    ).rejects.toThrow(/action/i)
  })

  it('rejects empty pattern', async () => {
    await expect(
      store.save('ws-1', {
        v: 1,
        presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
        customRules: [{ id: 'cr-1', pattern: '', isRegex: false, action: 'deny' }],
      }),
    ).rejects.toThrow(/pattern/i)
  })

  it('rejects customRules > 100', async () => {
    const rules = Array.from({ length: 101 }, (_, i) => ({ id: `cr-${i}`, pattern: `pattern-${i}`, isRegex: false as const, action: 'deny' as const }))
    await expect(
      store.save('ws-1', {
        v: 1,
        presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
        customRules: rules,
      }),
    ).rejects.toThrow(/100/i)
  })

  it('rejects invalid custom action', async () => {
    await expect(
      store.save('ws-1', {
        v: 1,
        presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' },
        customRules: [{ id: 'cr-1', pattern: 'foo', isRegex: false, action: 'off' as unknown as 'deny' }],
      }),
    ).rejects.toThrow(/action/i)
  })

  it('rejects missing preset keys by filling defaults check - incomplete presets', async () => {
    await expect(
      store.save('ws-1', {
        v: 1,
        presets: { fsDestructive: 'deny' } as unknown as Record<string, string> as never,
        customRules: [],
      }),
    ).rejects.toThrow()
  })

  it('save without expectedHash succeeds even when file exists (first save pattern)', async () => {
    await store.save('ws-1', { v: 1, presets: { fsDestructive: 'deny', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] })
    // second save without hash should not throw (per plan: if not provided and file exists, it's ok)
    await expect(
      store.save('ws-1', { v: 1, presets: { fsDestructive: 'off', gitDestructive: 'ask', systemPriv: 'ask', networkExfil: 'deny', dbDestructive: 'ask', resourceExhaust: 'deny' }, customRules: [] }),
    ).resolves.toBeDefined()
  })

  it('hash is sha256 of JSON.stringify(config)', async () => {
    const cfg = { v: 1 as const, presets: { fsDestructive: 'deny' as const, gitDestructive: 'ask' as const, systemPriv: 'ask' as const, networkExfil: 'deny' as const, dbDestructive: 'ask' as const, resourceExhaust: 'deny' as const }, customRules: [] }
    const { hash } = await store.save('ws-1', cfg)
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(JSON.stringify(cfg)).digest('hex')
    expect(hash).toBe(expected)
  })
})
