/**
 * G3 modes: bundled four, custom file parsing/validation, hash pinning,
 * duplication, and the read-only bundled guarantee.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUNDLED_MODES, DEFAULT_MODE_ID, ModesService, ModeError, parseModeFile, serializeModeFile } from 'mini-dsh'

let home = ''

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g3-modes-'))
})

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const WS = 'ws-modes' as never

describe('bundled modes', () => {
  it('exactly four bundled modes exist and replace the generic Agent preset', () => {
    expect(BUNDLED_MODES.map((mode) => mode.id)).toEqual([
      'ask-before-changes', 'edit-automatically', 'plan', 'full-access',
    ])
    expect(BUNDLED_MODES).toHaveLength(4)
  })

  it('a custom mode can expose no tools and disable every context loader', async () => {
    const modes = new ModesService(home)
    await modes.save(WS, 'silent', [
      '---',
      'name: Silent',
      'toolExposure: []',
      'workspaceInstructions: false',
      'skills: off',
      'memoryPinned: false',
      'memoryRetrieval: false',
      '---',
      '',
      'You are a conversational assistant with no tools and no workspace context.',
    ].join('\n'))
    const silent = await modes.resolve(WS, 'silent')
    expect(silent.source).toBe('workspace')
    expect(silent.definition.toolExposure).toEqual([])
    expect(silent.definition.sources.workspaceInstructions).toBe(false)
    expect(silent.definition.sources.skills).toBe('off')
    expect(silent.definition.sources.memoryPinned).toBe(false)
    expect(silent.definition.sources.memoryRetrieval).toBe(false)
  })

  it('every mode has exactly the four fields with distinct defaults vs exposure', async () => {
    const modes = new ModesService(home)
    for (const id of ['ask-before-changes', 'edit-automatically', 'plan', 'full-access']) {
      const mode = await modes.resolve(WS, id)
      expect(mode.definition.instructions.length).toBeGreaterThan(0)
      expect(mode.definition.sources.history).toBeTruthy()
      expect(Array.isArray(mode.definition.toolExposure)).toBe(true)
      expect(typeof mode.definition.permissionDefaults).toBe('object')
    }
    // Plan is read-only: no write/edit/bash/memory-write exposure.
    const plan = await modes.resolve(WS, 'plan')
    expect(plan.definition.toolExposure).not.toContain('Write')
    expect(plan.definition.toolExposure).not.toContain('Edit')
    expect(plan.definition.toolExposure).not.toContain('Bash')
    expect(plan.definition.toolExposure).not.toContain('MemoryCreate')
    // Full access allows bash — and says it is not sandboxed.
    const full = await modes.resolve(WS, 'full-access')
    expect(full.definition.permissionDefaults.Bash).toBe('allow')
    expect(full.definition.instructions).toMatch(/no OS sandbox/i)
  })
})

describe('custom modes', () => {
  it('saves, lists, and resolves a workspace mode with a content hash', async () => {
    const modes = new ModesService(home)
    const raw = `---\nname: "Deep Work"\nhistory: "none"\nskills: "off"\ntoolExposure: ["Read", "Grep"]\npermissionDefaults: {"Read": "allow"}\n---\n\nFocus mode: answer only from the open conversation.`
    const saved = await modes.save(WS, 'deep-work', raw)
    expect(saved.source).toBe('workspace')
    expect(saved.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.definition.name).toBe('Deep Work')
    expect(saved.definition.sources.history).toBe('none')
    expect(saved.definition.sources.skills).toBe('off')
    expect(saved.definition.toolExposure).toEqual(['Read', 'Grep'])

    const listed = await modes.list(WS)
    expect(listed.find((row) => row.definition.id === 'deep-work')?.definition.name).toBe('Deep Work')
    // Bundled ids stay bundled.
    expect(listed.find((row) => row.definition.id === 'deep-work')?.source).toBe('workspace')
    expect((await modes.resolve(WS, DEFAULT_MODE_ID)).source).toBe('bundled')
  })

  it('invalid mode content is rejected, never coerced into a different mode', async () => {
    const modes = new ModesService(home)
    // A bad history value is a validation error, not a silent fallback.
    await expect(modes.save(WS, 'weird', '---\nhistory: "sometimes"\n---\n\nbody')).rejects.toMatchObject({ code: 'invalid' })
    // Unknown frontmatter keys are rejected.
    await expect(modes.save(WS, 'weird2', '---\nbanana: true\n---\n\nbody')).rejects.toMatchObject({ code: 'invalid' })
    // Unknown tool names in exposure are rejected against the known set.
    await expect(modes.save(WS, 'weird3', '---\ntoolExposure: ["Read", "Deploy"]\n---\n\nbody')).rejects.toMatchObject({ code: 'invalid' })
    // Invalid permission values are rejected.
    await expect(modes.save(WS, 'weird4', '---\npermissionDefaults: {"Read": "sometimes"}\n---\n\nbody')).rejects.toMatchObject({ code: 'invalid' })
    // Bad ids are refused outright.
    await expect(modes.save(WS, 'Not Kebab!', '---\n---\n\nx')).rejects.toMatchObject({ code: 'invalid' })
    // Unknown ids fail loud.
    await expect(modes.resolve(WS, 'no-such-mode')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('permission keys cover every rung the approval gate resolves and canonical serialization is stable', () => {
    const definition = parseModeFile('wide-perms', `---\nname: "Wide"\npermissionDefaults: {"Read": "allow", "mcp__github__create_issue": "ask", "mcp__github__*": "allow", "*": "deny"}\n---\n\nbody`)
    expect(definition.permissionDefaults).toEqual({
      Read: 'allow',
      mcp__github__create_issue: 'ask',
      'mcp__github__*': 'allow',
      '*': 'deny',
    })

    const serialized = serializeModeFile(definition)
    expect(serializeModeFile(parseModeFile('wide-perms', serialized))).toBe(serialized)
  })

  it('rejects permission keys the gate could never match with accepted shapes', () => {
    for (const key of [
      'mcp__*__read', 'Ba*h', 'bash',
      'mcp__foo bar__read', 'mcp__a____read', 'mcp__a____*',
      'mcp____read', 'mcp__github__',
    ]) {
      expect(() => parseModeFile('bad-perms', `---\npermissionDefaults: {${JSON.stringify(key)}: "allow"}\n---\n\nbody`))
        .toThrow(/known tool.*mcp__<server>__<tool>.*mcp__<server>__\*.*'\*'/)
    }
  })

  it('bundled modes cannot be overwritten or deleted; duplicate creates a copy', async () => {
    const modes = new ModesService(home)
    await expect(modes.save(WS, 'full-access', '---\n---\nhacked')).rejects.toMatchObject({ code: 'duplicate' })
    await expect(modes.delete(WS, 'full-access')).rejects.toMatchObject({ code: 'duplicate' })

    const copy = await modes.duplicate(WS, 'plan', 'plan-custom')
    expect(copy.definition.name).toBe('Plan')
    expect(copy.definition.id).toBe('plan-custom')
    expect(copy.source).toBe('workspace')
    // Customizing the copy does not touch the bundled original; a read
    // supplies the optimistic-concurrency hash required for replacement.
    const editable = await modes.load(WS, 'plan-custom')
    await modes.save(WS, 'plan-custom', `---\nname: "My Plan"\n---\n\ncustom body`, editable.hash)
    expect((await modes.resolve(WS, 'plan')).definition.instructions).not.toBe('custom body')
  })

  it('expectedHash conflicts surface instead of clobbering external edits', async () => {
    const modes = new ModesService(home)
    await modes.save(WS, 'conflict-mode', '---\nname: "V1"\n---\n\nv1 body')
    // External edit happens behind our back.
    const file = path.join(home, 'workspaces', WS as string, 'modes', 'conflict-mode.md')
    await fs.writeFile(file, '---\nname: "V2"\n---\n\nv2 body', 'utf8')
    await expect(modes.save(WS, 'conflict-mode', '---\nname: "V3"\n---\n\nv3', '0000')).rejects.toMatchObject({ code: 'conflict' })
    expect(await fs.readFile(file, 'utf8')).toContain('v2 body')
  })

  it('load returns editable content: real bytes for a file, canonical form for bundled', async () => {
    const modes = new ModesService(home)
    const raw = '---\nname: "Loadable"\n---\n\nbody text'
    await modes.save(WS, 'loadable', raw)
    const loaded = await modes.load(WS, 'loadable')
    expect(loaded).toMatchObject({ id: 'loadable', raw, source: 'workspace' })
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/)

    // Bundled: what Duplicate would write, and no hash to conflict against.
    const bundled = await modes.load(WS, 'plan')
    expect(bundled.source).toBe('bundled')
    expect(bundled.hash).toBeUndefined()
    expect(parseModeFile('plan', bundled.raw).permissionDefaults)
      .toEqual(BUNDLED_MODES.find((mode) => mode.id === 'plan')?.permissionDefaults)

    await expect(modes.load(WS, 'nope')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('selecting a deleted custom mode falls back at resolution (host contract)', async () => {
    const modes = new ModesService(home)
    await modes.save(WS, 'temp-mode', '---\nname: "Temp"\n---\n\nbody')
    await modes.delete(WS, 'temp-mode')
    await expect(modes.resolve(WS, 'temp-mode')).rejects.toBeInstanceOf(ModeError)
  })
})
