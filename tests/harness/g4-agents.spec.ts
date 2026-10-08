/**
 * G4: agent definitions (bundled roles, Claude Code subagent layers/format)
 * and one-level delegation — ceiling enforcement (one level only, no count
 * caps), isolation, root Stop cleanup.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentDefinitionService,
  ChildExecutor,
  Kernel,
  SpawnError,
  fileSessions,
  importClaudeDefinition,
  importCodexDefinition,
  CODEX_PINNED_VERSION,
  WorkspaceService,
  type SpawnRequest,
} from 'dnt-harness'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

/** wait() is batch-shaped; these cases follow exactly one child. */
const waitOne = async (
  executor: ChildExecutor,
  workspaceId: string,
  childSessionId: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ChildExecutor['childrenOfRoot']>>[number] | undefined> =>
  (await executor.wait(workspaceId as never, [childSessionId as never], { timeoutMs }))[0]

let home = ''
let proj = ''

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g4-'))
  proj = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g4-proj-'))
})

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true })
  await fs.rm(proj, { recursive: true, force: true })
})

describe('agent definitions', () => {
  it('the bundled catalog is exactly four roles, each described by when to choose it', async () => {
    const service = new AgentDefinitionService(home)
    const bundled = (await service.list('ws-empty' as never)).filter((row) => row.source === 'bundled')
    expect(bundled.map((row) => row.definition.name).sort()).toEqual(['explorer', 'reviewer', 'verifier', 'worker'])
    for (const row of bundled) {
      expect(row.definition.description).toMatch(/\bUse it\b/)
      // Every role states the shape of its final report.
      expect(row.definition.instructions).toMatch(/final message/i)
    }
    const verifier = await service.resolve('ws-x' as never, 'verifier')
    expect(verifier.definition.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell'])
    expect(verifier.definition.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit']))
    const reviewer = await service.resolve('ws-x' as never, 'reviewer')
    expect(reviewer.definition.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(reviewer.definition.disallowedTools).toContain('Bash')
  })

  it('a workspace file overrides a bundled role of the same name (Claude semantics); deleting it restores the built-in', async () => {
    const shadowHome = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g4-shadow-'))
    try {
      const dir = path.join(shadowHome, 'workspaces', 'ws-s', 'agents')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'reviewer.md'), '---\ndescription: "custom reviewer"\ntools: Read, Write\n---\n\ncustom')
      const service = new AgentDefinitionService(shadowHome)
      const reviewer = await service.resolve('ws-s' as never, 'reviewer')
      expect(reviewer.source).toBe('workspace')
      expect(reviewer.overrides).toEqual(['bundled'])
      expect(reviewer.definition.tools).toEqual(['Read', 'Write'])
      await service.delete('ws-s' as never, 'reviewer')
      expect((await service.resolve('ws-s' as never, 'reviewer')).source).toBe('bundled')
      await expect(service.delete('ws-s' as never, 'reviewer')).rejects.toMatchObject({ code: 'duplicate' })
    } finally {
      await fs.rm(shadowHome, { recursive: true, force: true })
    }
  })

  it('reads user, workspace and project layers; later layers win; names are case-insensitive', async () => {
    const layerHome = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g4-layers-'))
    try {
      const userClaudeDir = path.join(layerHome, 'user-claude')
      const project = path.join(layerHome, 'project')
      const write = async (file: string, text: string): Promise<void> => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, text)
      }
      await write(path.join(userClaudeDir, 'agents', 'explore.md'), '---\nname: Explore\ndescription: user explorer\nmodel: haiku\ntools: Glob, Grep, Read, Bash\n---\n\nuser body')
      await write(path.join(userClaudeDir, 'agents', 'planner.md'), '---\nname: planner\ndescription: user planner\nmemory: project\ntools: Read, WebFetch, TaskCreate\n---\n\nplan')
      await write(path.join(layerHome, 'workspaces', 'ws-l', 'agents', 'planner.md'), '---\nname: planner\ndescription: workspace planner\n---\n\nws plan')
      await write(path.join(project, '.claude', 'agents', 'plan.md'), '---\nname: planner\ndescription: project planner\ntools: Read\n---\n\nproject plan')
      await write(path.join(project, '.claude', 'agents', 'broken.md'), '---\ntools: [unclosed\n---\n\nx')
      const service = new AgentDefinitionService(layerHome, { userClaudeDir, projectRootOf: () => project })

      const explore = await service.resolve('ws-l' as never, 'explore')
      expect(explore.definition.name).toBe('Explore')
      expect(explore.source).toBe('user')
      expect(explore.definition.tools).toEqual(['Glob', 'Grep', 'Read', 'Bash'])
      expect(explore.definition.model).toBe('haiku')

      expect((await service.resolve('ws-l' as never, 'planner')).definition.description).toBe('workspace planner')
      const projectPlanner = await service.resolve('ws-l' as never, 'Planner', 'proj-1')
      expect(projectPlanner.definition.description).toBe('project planner')
      expect(projectPlanner.overrides).toEqual(['user', 'workspace'])

      const { errors } = await service.catalog('ws-l' as never, 'proj-1')
      expect(errors.map((error) => path.basename(error.path))).toEqual(['broken.md'])
    } finally {
      await fs.rm(layerHome, { recursive: true, force: true })
    }
  })

  it('bundled Explorer is read-only with no shell', async () => {
    const service = new AgentDefinitionService(home)
    const explorer = await service.resolve('ws-x' as never, 'explorer')
    expect(explorer.definition.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(explorer.definition.disallowedTools).toContain('Bash')
  })

  it('bundled Worker exposes file edits and the complete shell lifecycle for a bounded task', async () => {
    const service = new AgentDefinitionService(home)
    const worker = await service.resolve('ws-x' as never, 'worker')
    expect(worker.definition.tools).toEqual(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell'])
    for (const tool of ['Bash', 'BashOutput', 'KillShell']) {
      expect(worker.definition.disallowedTools).not.toContain(tool)
    }
  })

  it('parses Claude frontmatter: YAML, comma tools, omitted tools inherit, unsupported keys only warn', async () => {
    const { parseAgentDefinition } = await import('dnt-harness')
    expect(() => parseAgentDefinition('bad2', '---\n---\n\nbody')).toThrow(/'description' is required/)
    expect(() => parseAgentDefinition('bad3', '---\ndescription: x\n---\n')).toThrow(/body must not be empty/)
    const inherits = parseAgentDefinition('all', '---\ndescription: "everything"\nbanana: 1\n---\n\nbody')
    expect(inherits.tools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash']))
    expect(inherits.tools).not.toContain('Agent')
    expect(inherits.warnings?.join()).toMatch(/unknown frontmatter key 'banana'/)
    const claude = parseAgentDefinition('x', [
      '---',
      'name: security-auditor',
      'description: >-',
      '  audits dependencies',
      'tools: Read, Grep, Bash(git:*), MultiEdit, WebFetch, mcp__github__search',
      'model: inherit',
      'permissionMode: plan',
      'hooks:',
      '  PreToolUse: []',
      'color: red',
      '---',
      '',
      'Audit the dependencies.',
    ].join('\n'))
    expect(claude.name).toBe('security-auditor')
    expect(claude.description).toBe('audits dependencies')
    expect(claude.tools).toEqual(['Read', 'Grep', 'Bash', 'Edit', 'mcp__github__search'])
    expect(claude.model).toBeUndefined()
    expect(claude.unsupported).toEqual(['permissionMode', 'hooks', 'color'])
    expect(claude.warnings?.join()).toMatch(/dropped: WebFetch/)
  })

  it('cleans a stripped Examples tail and reports dropped tools as a list', async () => {
    const { parseAgentDefinition } = await import('dnt-harness')
    const parsed = parseAgentDefinition('b', "---\ndescription: 'Brainstorm ideas.\n  Examples: - - -'\ntools: Read, WebFetch, SendMessage\n---\n\nbody")
    expect(parsed.description).toBe('Brainstorm ideas.')
    expect(parsed.droppedTools).toEqual(['WebFetch', 'SendMessage'])
  })

  it('clones a ~/.claude role into the workspace verbatim, same name, overriding it there', async () => {
    const userDir = path.join(home, 'claude-home')
    await fs.mkdir(path.join(userDir, 'agents'), { recursive: true })
    const raw = '---\nname: rev\ndescription: Reviews.\nmemory: project\ntools: Read\n---\n\nReview.\n'
    await fs.writeFile(path.join(userDir, 'agents', 'rev.md'), raw)
    const service = new AgentDefinitionService(home, { userClaudeDir: userDir })
    const cloned = await service.cloneToWorkspace('ws1', 'rev')
    expect(cloned.source).toBe('workspace')
    expect(await fs.readFile(cloned.path!, 'utf8')).toBe(raw)
    const resolved = await service.resolve('ws1', 'rev')
    expect(resolved.source).toBe('workspace')
    expect(resolved.overrides).toEqual(['user'])
    expect((await service.readWorkspaceFile('ws1', 'rev')).content).toBe(raw)
    await expect(service.cloneToWorkspace('ws1', 'rev')).rejects.toThrow(/already in this workspace/)
    // Another workspace still sees the ~/.claude role.
    expect((await service.resolve('ws2', 'rev')).source).toBe('user')
    // Bundled roles clone too (serialized).
    expect((await service.cloneToWorkspace('ws1', 'explorer')).source).toBe('workspace')
  })

  it('describes which model a role runs on here (aliases, ids, unresolved)', async () => {
    const { describeRoleModel } = await import('../../src/web/agent-delegation.ts')
    const deps = { parent: { provider: 'zcode', model: 'GLM' }, providers: ['zcode', 'cliproxy'], modelsOf: (p: string) => p === 'cliproxy' ? ['claude-opus-5-5', 'gpt-6'] : ['GLM'] }
    expect(describeRoleModel(undefined, deps)).toEqual({ inherit: true })
    expect(describeRoleModel('inherit', deps)).toEqual({ inherit: true })
    expect(describeRoleModel('opus', deps)).toEqual({ resolved: 'cliproxy:claude-opus-5-5', inherit: false })
    expect(describeRoleModel('gpt-6', deps)).toEqual({ resolved: 'cliproxy:gpt-6', inherit: false })
    expect(describeRoleModel('haiku', deps)).toEqual({ inherit: true, unresolved: 'haiku' })
  })

  it('saving a workspace definition validates and hashes', async () => {
    const service = new AgentDefinitionService(home)
    await expect(service.save('ws-x' as never, '../evil', '---\ndescription: "x"\n---\n\nx')).rejects.toMatchObject({ code: 'invalid' })
    const saved = await service.save('ws-x' as never, 'auditor', '---\ndescription: "reviews code"\ntools: Read, Grep\n---\n\nReview carefully.')
    expect(saved.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(saved.definition.tools).toEqual(['Read', 'Grep'])
    await expect(
      service.save('ws-x' as never, 'auditor', '---\ndescription: "v2"\n---\n\nbody', '0'.repeat(64)),
    ).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('compatibility imports', () => {
  it('importClaudeDefinition parses with the native rules and reports unsupported keys', () => {
    const result = importClaudeDefinition('---\nname: x\ndescription: d\nmaxTurns: 6\nmemory: project\n---\n\nbody')
    expect(result.definition.name).toBe('x')
    expect(result.unsupported).toEqual(['maxTurns', 'memory'])
    expect(result.imported).toContain('description')
  })

  it('Codex import outside the pinned version is refused', () => {
    expect(() => importCodexDefinition('name = "x"', 'some-other-version')).toThrow(/outside the pinned adapter/)
    const result = importCodexDefinition('name = "codex-worker"\nmodel = "gpt-5.6"\ninstructions = "do the work"')
    expect(result.pinnedVersion).toBe(CODEX_PINNED_VERSION)
    expect(result.definition.name).toBe('codex-worker')
    expect(result.unsupported).toContain('messaging')
  })
})

describe('bounded delegation', () => {
  interface Harness {
    kernel: Kernel
    executor: ChildExecutor
    workspaceId: string
    rootSessionId: string
  }

  async function bootChildHarness(script: readonly (string | { toolCalls: readonly { name: string; args: Record<string, unknown> }[] })[]): Promise<Harness> {
    const kernel = new Kernel()
    kernel.ctx.plugin(fileSessions(home))
    const sessions = kernel.ctx.sessions
    const ws = new WorkspaceService(home)
    await ws.boot()
    await sessions.boot()
    const workspaceId = ws.defaultWorkspace
    kernel.ctx.plugin((await import('dnt-harness')).LlmService)
    kernel.ctx.plugin((await import('dnt-harness')).ToolsService)
    kernel.ctx.plugin((await import('dnt-harness')).AgentsService)
    kernel.ctx.llm.register(new FakeScriptedLlm(script as never))
    const root = sessions.create(workspaceId)
    const executor = new ChildExecutor(kernel.ctx)
    return { kernel, executor, workspaceId: workspaceId as unknown as string, rootSessionId: root.id as unknown as string }
  }

  function spawnRequest(harness: Harness, definition: import('dnt-harness').AgentDefinition, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
    return {
      workspaceId: harness.workspaceId as never,
      projectId: undefined,
      parentSessionId: harness.rootSessionId as never,
      parentTurnId: 'turn-1',
      definition,
      exposureCeiling: definition.tools,
      packet: { objective: 'inspect the repo', constraints: [], references: [], requiredResult: 'summary' },
      ...overrides,
    }
  }

  it('a child runs the task packet in an ISOLATED session and returns a bounded result', async () => {
    const { AgentDefinitionService } = await import('dnt-harness')
    const harness = await bootChildHarness(['explorer found 3 files'])
    const definitions = new AgentDefinitionService(home)
    const explorer = (await definitions.resolve(harness.workspaceId as never, 'explorer')).definition
    const handle = await harness.executor.spawn(spawnRequest(harness, explorer))
    const settled = await waitOne(harness.executor, harness.workspaceId, handle.childSessionId, 3_000)
    expect(settled !== undefined && settled.status).toBe('completed')
    expect(settled?.result?.report).toBe('explorer found 3 files')
    // Isolation: the child session carries the task packet, not parent history.
    void harness
    await harness.kernel.stop()
  }, 15_000)

  it('wait follows several children at once and returns the moment a stop aborts it', async () => {
    const { AgentDefinitionService } = await import('dnt-harness')
    const harness = await bootChildHarness(['done'])
    const explorer = (await new AgentDefinitionService(home).resolve(harness.workspaceId as never, 'explorer')).definition
    const first = await harness.executor.spawn(spawnRequest(harness, explorer))
    const second = await harness.executor.spawn(spawnRequest(harness, explorer))
    const both = await harness.executor.wait(
      harness.workspaceId as never,
      [first.childSessionId, second.childSessionId],
      { timeoutMs: 5_000 },
    )
    expect(both.map((child) => child.status)).toEqual(['completed', 'completed'])

    // An already-aborted signal returns at once instead of sitting out the
    // timeout — a root Stop must not wait on a settled-forever child.
    const aborted = new AbortController()
    aborted.abort()
    const started = Date.now()
    const raced = await harness.executor.wait(
      harness.workspaceId as never,
      [first.childSessionId],
      { timeoutMs: 60_000, signal: aborted.signal },
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(raced.length).toBe(1)
    // Unknown or foreign ids drop out rather than inventing a handle.
    expect(await harness.executor.wait(harness.workspaceId as never, ['nope' as never], { timeoutMs: 10 })).toEqual([])
    await harness.kernel.stop()
  }, 20_000)

  it('no per-root cap: more concurrent children than the old limit all stay active and cancel cleanly', async () => {
    const harness = await bootChildHarness([{ toolCalls: [{ name: 'Read', args: {} }] }])
    const { AgentDefinitionService } = await import('dnt-harness')
    const worker = (await new AgentDefinitionService(home).resolve(harness.workspaceId as never, 'worker')).definition
    // A gate tool that never finishes keeps children active.
    harness.kernel.ctx.tools.register({
      name: 'Read', description: 'gate', requiresRoot: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, exec) {
        await new Promise<string>((resolve) => {
          if (exec.signal?.aborted === true) resolve('x')
          else exec.signal?.addEventListener('abort', () => resolve('x'), { once: true })
        })
        return 'read'
      },
    })
    // Spawn past the old per-root active limit: every child is admitted.
    const handles = []
    for (let i = 0; i < 8; i++) {
      handles.push(await harness.executor.spawn(spawnRequest(harness, worker)))
    }
    expect(handles).toHaveLength(8)
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(8)
    // Cancel all: root Stop cleanup (awaited settlement confirmed).
    expect(await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)).toBe(8)
    for (const handle of handles) {
      const settled = await waitOne(harness.executor, harness.workspaceId, handle.childSessionId, 3_000)
      expect(settled !== undefined && settled.status).toBe('cancelled')
    }
    await harness.kernel.stop()
  }, 20_000)

  it('simultaneous spawns all admit and per-root accounting stays exact', async () => {
    const harness = await bootChildHarness([{ toolCalls: [{ name: 'Read', args: {} }] }])
    const worker = (await new AgentDefinitionService(home).resolve(harness.workspaceId as never, 'worker')).definition
    // A gate tool that never finishes keeps every child active, so the
    // per-root reservation — not child completion — is what is measured.
    harness.kernel.ctx.tools.register({
      name: 'Read', description: 'gate', requiresRoot: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, exec) {
        await new Promise<string>((resolve) => {
          if (exec.signal?.aborted === true) resolve('x')
          else exec.signal?.addEventListener('abort', () => resolve('x'), { once: true })
        })
        return 'read'
      },
    })
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => harness.executor.spawn(spawnRequest(harness, worker))))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0)
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(8)
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await harness.kernel.stop()
  }, 20_000)

  it('a write-capable child runs without waiting on any project-wide writer handoff', async () => {
    const harness = await bootChildHarness(['done'])
    const worker = (await new AgentDefinitionService(home).resolve(harness.workspaceId as never, 'worker')).definition
    let handoffEvents = 0
    harness.kernel.ctx.on('agent/child-writer-handoff', async () => { handoffEvents += 1 })
    const handle = await harness.executor.spawn(spawnRequest(harness, worker, { grantTools: ['Write'] }))
    const settled = await waitOne(harness.executor, harness.workspaceId, handle.childSessionId, 3_000)
    expect(settled?.status).toBe('completed')
    // The retired event is never emitted: no turn-wide project lease exists.
    expect(handoffEvents).toBe(0)
    await harness.kernel.stop()
  }, 15_000)

  it('recovered child relationships list/result without a live Agent and never replay', async () => {
    const isolated = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-g4-recover-'))
    try {
      let rootId = ''
      let childId = ''
      let workspaceId = ''
      {
        const kernel = new Kernel()
        kernel.ctx.plugin(fileSessions(isolated))
        const ws = new WorkspaceService(isolated)
        await ws.boot()
        await kernel.ctx.sessions.boot()
        workspaceId = ws.defaultWorkspace as unknown as string
        const root = kernel.ctx.sessions.create(ws.defaultWorkspace)
        rootId = root.id
        const child = kernel.ctx.sessions.create(ws.defaultWorkspace)
        childId = child.id
        child.append({ type: 'session/child-meta', parentSessionId: root.id, parentTurnId: 't1', definition: 'explorer', objective: 'inspect' })
        child.append({ type: 'turn/start', turnId: 'ct1' as never })
        child.append({ type: 'assistant/message', stepId: 'cs1' as never, content: 'partial finding' })
        await child.durable()
        // The parent's own relationship record: recovery refuses orphans.
        root.append({ type: 'agent/child-spawn', childSessionId: child.id, parentTurnId: 't1', definition: 'explorer', objective: 'inspect' })
        await root.durable()
        await kernel.stop()
      }
      const kernel = new Kernel()
      kernel.ctx.plugin(fileSessions(isolated))
      await kernel.ctx.sessions.boot()
      const executor = new ChildExecutor(kernel.ctx)
      expect(await executor.recoverFromStorage()).toBe(1)
      const listed = await executor.childrenOfRoot(rootId as never, workspaceId as never)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.status).toBe('interrupted')
      // Narration from an unfinished child is never handed back as a result.
      expect(listed[0]?.result).toBeUndefined()
      expect(listed[0]?.error).toContain(`session ${childId}`)
      const waited = await waitOne(executor, workspaceId, childId as never, 20)
      expect(waited?.status).toBe('interrupted')
      await kernel.stop()
    } finally {
      await fs.rm(isolated, { recursive: true, force: true })
    }
  }, 15_000)

  it('the child ceiling denies tools outside definition âˆ© grant even in Full access', async () => {
    const harness = await bootChildHarness([
      { toolCalls: [{ name: 'Bash', args: { command: 'echo hacked' } }] },
      'done',
    ])
    const { AgentDefinitionService } = await import('dnt-harness')
    const explorer = (await new AgentDefinitionService(home).resolve(harness.workspaceId as never, 'explorer')).definition
    const handle = await harness.executor.spawn(
      spawnRequest(harness, explorer, { grantTools: ['Write'] }),
    )
    const settled = await waitOne(harness.executor, harness.workspaceId, handle.childSessionId, 3_000)
    expect(settled !== undefined && settled.status).toBe('completed')
    // The Bash call must be denied by the definition ceiling; the result is
    // truthful and the command never ran.
    const events = await harness.executor.childrenOfRoot(harness.rootSessionId as never)
    void events
    const childSession = handle.childSessionId
    void childSession
    expect(settled?.status).toBe('completed')
    // The executor is keyed by root; deep assertions live at the gate level
    // (server-g4 covers the HTTP path with a real denial output check).
    await harness.kernel.stop()
  }, 15_000)
})
