import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadHooks } from '../../src/harness/hooks/settings.ts'
import { CommandsService } from '../../src/harness/commands/service.ts'
import { AgentDefinitionService } from '../../src/harness/agents/definition-service.ts'
import {
  ResourceSourcesError,
  ResourceSourcesStore,
  defaultResourceSources,
  validateSourcesInput,
} from '../../src/harness/sources/resource-sources.ts'

let home = ''
const WS = 'ws-1'

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-res-src-'))
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const wsDir = (): string => path.join(home, 'workspaces', WS)

describe('ResourceSourcesStore', () => {
  it('serves defaults while no file exists, with every fixed layer on', async () => {
    const store = new ResourceSourcesStore(home, '/u/skills')
    const state = await store.read(WS)
    expect(state.error).toBeUndefined()
    expect(state.doc.skills.rules.map((rule) => rule.id)).toEqual(['project-claude', 'project-agents', 'workspace', 'user'])
    expect([...(await store.disabled(WS, 'agents'))]).toEqual([])
  })

  it('imports the legacy skills/sources.json until the first save, and leaves that file alone', async () => {
    await fs.mkdir(path.join(wsDir(), 'skills'), { recursive: true })
    const legacy = JSON.stringify({ rules: [{ id: 'only-ws', kind: 'workspace', enabled: false }] })
    await fs.writeFile(path.join(wsDir(), 'skills', 'sources.json'), legacy, 'utf8')
    const store = new ResourceSourcesStore(home)
    expect((await store.read(WS)).doc.skills.rules).toEqual([{ id: 'only-ws', kind: 'workspace', enabled: false }])

    await store.update(WS, (doc) => ({ ...doc, disabled: { ...doc.disabled, agents: ['user'] } }))
    // The shared document now wins, and it carried the imported rules across.
    expect((await store.read(WS)).doc.skills.rules).toEqual([{ id: 'only-ws', kind: 'workspace', enabled: false }])
    expect(await fs.readFile(path.join(wsDir(), 'skills', 'sources.json'), 'utf8')).toBe(legacy)
    await fs.writeFile(path.join(wsDir(), 'skills', 'sources.json'), JSON.stringify({ rules: [] }), 'utf8')
    expect((await store.read(WS)).doc.skills.rules).toHaveLength(1)
  })

  it('writing one kind keeps the others, and the revision moves only on a write', async () => {
    const store = new ResourceSourcesStore(home)
    expect(store.revision(WS)).toBe(0)
    await store.update(WS, (doc) => ({ ...doc, disabled: { ...doc.disabled, hooks: ['user'] } }))
    await store.update(WS, (doc) => ({ ...doc, disabled: { ...doc.disabled, commands: ['bundled'] } }))
    expect(store.revision(WS)).toBe(2)
    expect([...(await store.disabled(WS, 'hooks'))]).toEqual(['user'])
    expect([...(await store.disabled(WS, 'commands'))]).toEqual(['bundled'])
    await store.read(WS)
    expect(store.revision(WS)).toBe(2)
  })

  it('refuses a stale expectedHash and applies a fresh one', async () => {
    const store = new ResourceSourcesStore(home)
    const loaded = await store.read(WS)
    // Another editor saves first; the hash this editor loaded is now stale.
    await store.write(WS, { ...loaded.doc, disabled: { ...loaded.doc.disabled, hooks: ['local'] } }, loaded.hash)
    await expect(
      store.write(WS, { ...loaded.doc, disabled: { ...loaded.doc.disabled, agents: ['user'] } }, loaded.hash),
    ).rejects.toMatchObject({ code: 'conflict' })
    // Nothing from the refused write landed.
    expect([...(await store.disabled(WS, 'agents'))]).toEqual([])
    // Reloading gives the fresh hash, and that write goes through.
    const fresh = await store.read(WS)
    await store.write(WS, { ...fresh.doc, disabled: { ...fresh.doc.disabled, agents: ['user'] } }, fresh.hash)
    expect([...(await store.disabled(WS, 'agents'))]).toEqual(['user'])
    expect([...(await store.disabled(WS, 'hooks'))]).toEqual(['local'])
  })

  it('serializes concurrent updates so no kind is lost', async () => {
    const store = new ResourceSourcesStore(home)
    await Promise.all(['agents', 'hooks', 'commands'].map((kind) =>
      store.update(WS, (doc) => ({ ...doc, disabled: { ...doc.disabled, [kind]: [kind === 'hooks' ? 'user' : 'bundled'] } })),
    ))
    expect([...(await store.disabled(WS, 'agents'))]).toEqual(['bundled'])
    expect([...(await store.disabled(WS, 'hooks'))]).toEqual(['user'])
    expect([...(await store.disabled(WS, 'commands'))]).toEqual(['bundled'])
  })

  it('a broken file never re-enables anything: no valid copy → everything off, and updates refuse', async () => {
    const store = new ResourceSourcesStore(home, '/u/skills')
    await fs.mkdir(wsDir(), { recursive: true })
    await fs.writeFile(path.join(wsDir(), 'resource-sources.json'), '{broken', 'utf8')
    const state = await store.read(WS)
    expect(state.error).toMatch(/unusable/)
    expect(state.doc.skills.rules.every((rule) => !rule.enabled)).toBe(true)
    expect([...(await store.disabled(WS, 'hooks'))].sort()).toEqual(['local', 'plugin', 'project', 'user', 'workspace'])
    await expect(store.update(WS, (doc) => doc)).rejects.toBeInstanceOf(ResourceSourcesError)
    // An explicit whole-document write (the repair path) works.
    await store.write(WS, defaultResourceSources('/u/skills'))
    expect((await store.read(WS)).error).toBeUndefined()
  })

  it('a file that breaks after a good read keeps the last valid policy', async () => {
    const store = new ResourceSourcesStore(home)
    await store.update(WS, (doc) => ({ ...doc, disabled: { ...doc.disabled, agents: ['user'] } }))
    await fs.writeFile(path.join(wsDir(), 'resource-sources.json'), '{"v":2}', 'utf8')
    const state = await store.read(WS)
    expect(state.error).toBeDefined()
    expect([...state.doc.disabled.agents]).toEqual(['user'])
  })

  it('isolates workspaces', async () => {
    const store = new ResourceSourcesStore(home)
    await store.update('ws-a', (doc) => ({ ...doc, disabled: { ...doc.disabled, agents: ['user'] } }))
    expect([...(await store.disabled('ws-b', 'agents'))]).toEqual([])
    expect(store.revision('ws-b')).toBe(0)
  })
})

describe('validateSourcesInput', () => {
  const ok = { skills: { rules: [{ id: 'workspace', kind: 'workspace', enabled: true }] }, disabled: { agents: ['user'] } }

  it('accepts a well-formed document and fills missing kinds', () => {
    const doc = validateSourcesInput(ok)
    expect(doc.disabled).toEqual({ skills: [], agents: ['user'], hooks: [], commands: [] })
  })

  it('refuses unknown layers, wrong shapes and bad skill rules', () => {
    const bad: unknown[] = [
      null,
      { ...ok, disabled: { agents: ['galaxy'] } },
      { ...ok, disabled: { hooks: ['bundled'] } },
      { ...ok, disabled: { agents: 'user' } },
      { ...ok, disabled: 'x' },
      { skills: { rules: [{ id: 'a', kind: 'project', path: '../escape', enabled: true }] } },
      { skills: {} },
    ]
    for (const body of bad) expect(() => validateSourcesInput(body), JSON.stringify(body)).toThrow(ResourceSourcesError)
  })
})

describe('layer switches reach each subsystem', () => {
  const agentFile = (name: string): string => `---\nname: ${name}\ndescription: ${name} role\n---\n\nDo ${name}.\n`

  it('agents: a disabled layer leaves the catalog and a lower layer wins again', async () => {
    const userClaude = path.join(home, 'claude')
    await fs.mkdir(path.join(userClaude, 'agents'), { recursive: true })
    await fs.writeFile(path.join(userClaude, 'agents', 'explorer.md'), agentFile('explorer'), 'utf8')
    await fs.writeFile(path.join(userClaude, 'agents', 'mine.md'), agentFile('mine'), 'utf8')
    let off = new Set<string>()
    const service = new AgentDefinitionService(home, { userClaudeDir: userClaude, disabledLayers: async () => off })
    const sourceOf = async (name: string): Promise<string | undefined> => (await service.list(WS)).find((row) => row.definition.name === name)?.source
    expect(await sourceOf('explorer')).toBe('user')
    expect(await sourceOf('mine')).toBe('user')

    off = new Set(['user'])
    expect(await sourceOf('explorer')).toBe('bundled')
    expect(await sourceOf('mine')).toBeUndefined()
    await expect(service.resolve(WS, 'mine')).rejects.toMatchObject({ code: 'not-found' })

    off = new Set(['bundled'])
    expect(await sourceOf('worker')).toBeUndefined()
    expect(await sourceOf('mine')).toBe('user')
  })

  it('commands: workspace and user layers drop out of the catalog independently', async () => {
    const userClaude = path.join(home, 'claude')
    await fs.mkdir(path.join(userClaude, 'commands'), { recursive: true })
    await fs.writeFile(path.join(userClaude, 'commands', 'u-cmd.md'), 'user body', 'utf8')
    await fs.mkdir(path.join(wsDir(), 'commands'), { recursive: true })
    await fs.writeFile(path.join(wsDir(), 'commands', 'w-cmd.md'), 'workspace body', 'utf8')
    let off = new Set<string>()
    const service = new CommandsService(home, { userClaudeDir: userClaude, homeDir: home, disabledLayers: async () => off })
    const names = async (): Promise<string[]> => (await service.catalog(WS)).rows.map((row) => row.name).sort()
    expect(await names()).toEqual(['u-cmd', 'w-cmd'])
    off = new Set(['user'])
    expect(await names()).toEqual(['w-cmd'])
    off = new Set(['workspace'])
    expect(await names()).toEqual(['u-cmd'])
    expect(await service.find(WS, undefined, 'w-cmd')).toBeUndefined()
  })

  it('hooks: a disabled layer is neither read nor allowed to switch every hook off', async () => {
    const userDir = path.join(home, 'claude')
    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(path.join(userDir, 'settings.json'), JSON.stringify({ disableAllHooks: true, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user' }] }] } }), 'utf8')
    await fs.mkdir(wsDir(), { recursive: true })
    await fs.writeFile(path.join(wsDir(), 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ws' }] }] } }), 'utf8')

    const all = await loadHooks({ userDir, workspaceDir: wsDir() })
    expect(all.disabled).toBe(true)
    expect(all.hooks).toEqual([])

    const withoutUser = await loadHooks({ userDir, workspaceDir: wsDir(), disabledLayers: new Set(['user']) })
    expect(withoutUser.disabled).toBe(false)
    expect(withoutUser.all.map((hook) => hook.command)).toEqual(['echo ws'])
    expect(withoutUser.hooks.map((hook) => hook.command)).toEqual(['echo ws'])
    expect(withoutUser.sources.map((source) => source.layer)).toEqual(['workspace'])

    const withoutWorkspace = await loadHooks({ userDir, workspaceDir: wsDir(), disabledLayers: new Set(['workspace']) })
    expect(withoutWorkspace.disabled).toBe(true)
  })

  it('hooks: disabling plugin drops plugin hooks only', async () => {
    const plugin = { id: 'p@m', root: '/p', data: '/pd', label: 'plugin p', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo plugin' }] }] } }
    expect((await loadHooks({ plugins: [plugin] })).hooks).toHaveLength(1)
    expect((await loadHooks({ plugins: [plugin], disabledLayers: new Set(['plugin']) })).hooks).toHaveLength(0)
  })
})
