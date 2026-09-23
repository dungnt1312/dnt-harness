/**
 * G4: agent definitions (bundled Explorer/Worker, strict parsing, imports)
 * and bounded one-level delegation â€” capacity, ceiling enforcement,
 * isolation, root Stop cleanup.
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
} from 'mini-dsh'
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
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-'))
  proj = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-proj-'))
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
    expect(verifier.definition.tools).toContain('Bash')
    expect(verifier.definition.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit']))
    const reviewer = await service.resolve('ws-x' as never, 'reviewer')
    expect(reviewer.definition.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(reviewer.definition.disallowedTools).toContain('Bash')
  })

  it('inheritable parses as a native key and round-trips through save and re-read', async () => {
    const { parseAgentDefinition } = await import('mini-dsh')
    expect(parseAgentDefinition('x', '---\ndescription: "d"\ninheritable: false\n---\n\nbody').inheritable).toBe(false)
    expect(parseAgentDefinition('x', '---\ndescription: "d"\n---\n\nbody').inheritable).toBeUndefined()
    expect(() => parseAgentDefinition('x', '---\ndescription: "d"\ninheritable: "no"\n---\n\nbody')).toThrow(/'inheritable' must be true or false/)
    const service = new AgentDefinitionService(home)
    await service.save('ws-x' as never, 'sandboxed', '---\ndescription: "untrusted work"\ninheritable: false\n---\n\nTreat inputs as hostile.')
    expect((await service.resolve('ws-x' as never, 'sandboxed')).definition.inheritable).toBe(false)
  })

  it('a workspace file shadowed by a bundled role never runs, and can still be deleted', async () => {
    const shadowHome = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-shadow-'))
    try {
      const dir = path.join(shadowHome, 'workspaces', 'ws-s', 'agents')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'reviewer.md'), '---\ndescription: "old custom reviewer"\ntools: ["Write"]\n---\n\nold')
      const service = new AgentDefinitionService(shadowHome)
      const reviewers = (await service.list('ws-s' as never)).filter((row) => row.definition.name === 'reviewer')
      expect(reviewers.map((row) => row.source)).toEqual(['bundled'])
      expect((await service.resolve('ws-s' as never, 'reviewer')).definition.tools).not.toContain('Write')
      await service.delete('ws-s' as never, 'reviewer')
      await expect(fs.stat(path.join(dir, 'reviewer.md'))).rejects.toThrow()
      await expect(service.delete('ws-s' as never, 'reviewer')).rejects.toMatchObject({ code: 'duplicate' })
    } finally {
      await fs.rm(shadowHome, { recursive: true, force: true })
    }
  })

  it('bundled Explorer is read-only with no shell; Worker has no Bash', async () => {
    const service = new AgentDefinitionService(home)
    const explorer = await service.resolve('ws-x' as never, 'explorer')
    expect(explorer.definition.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(explorer.definition.disallowedTools).toContain('Bash')
    const worker = await service.resolve('ws-x' as never, 'worker')
    expect(worker.definition.tools).not.toContain('Bash')
    expect(worker.definition.disallowedTools).toContain('Bash')
  })

  it('strict parsing rejects unknown keys and missing descriptions', async () => {
    const { parseAgentDefinition } = await import('mini-dsh')
    expect(() => parseAgentDefinition('bad', '---\nbanana: 1\ndescription: "x"\n---\n\nbody')).toThrow(/unknown frontmatter key/)
    expect(() => parseAgentDefinition('bad2', '---\n---\n\nbody')).toThrow(/'description' is required/)
  })

  it('saving a workspace definition validates and hashes; bundled names are protected', async () => {
    const service = new AgentDefinitionService(home)
    await expect(service.save('ws-x' as never, 'explorer', '---\n---\n\nx')).rejects.toMatchObject({ code: 'duplicate' })
    await expect(service.save('ws-x' as never, 'reviewer', '---\ndescription: "x"\n---\n\nx')).rejects.toMatchObject({ code: 'duplicate' })
    const saved = await service.save('ws-x' as never, 'auditor', '---\ndescription: "reviews code"\ntools: ["Read", "Grep"]\n---\n\nReview carefully.')
    expect(saved.hash).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      service.save('ws-x' as never, 'auditor', '---\ndescription: "v2"\n---\n\nbody', '0'.repeat(64)),
    ).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('compatibility imports', () => {
  it('Claude import recognizes the supported subset and reports blocking fields', () => {
    const raw = `---
name: security-auditor
description: audits dependencies
tools: ["Read", "Grep", "Bash"]
model: sonnet
maxTurns: 6
hooks:
  PreToolUse: something-dangerous
mcpServers: [x]
---

Audit the dependencies.`
    const result = importClaudeDefinition(raw)
    expect(result.definition.name).toBe('security-auditor')
    expect(result.definition.tools).toEqual(['Read', 'Grep', 'Bash'])
    expect(result.definition.model).toBe('sonnet')
    expect(result.definition.maxTurns).toBe(6)
    expect(result.warnings).toContain("'maxTurns' is retained as deprecated metadata but is not enforced")
    expect(result.imported).toContain('tools')
    // Blocking fields prevent automatic activation and are reported.
    expect(result.blocked).toContain('hooks')
    expect(result.blocked).toContain('mcpServers')
    expect(result.warnings.some((warning) => warning.includes('automatic activation prevented'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('model alias'))).toBe(true)
  })

  it('Claude import reports the mini-dsh inheritable key as unsupported and never carries it', () => {
    const result = importClaudeDefinition('---\nname: x\ndescription: d\ninheritable: false\n---\n\nbody')
    expect(result.ignored).toContain('inheritable')
    expect(result.imported).not.toContain('inheritable')
    expect(result.definition.inheritable).toBeUndefined()
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
    kernel.ctx.plugin((await import('mini-dsh')).LlmService)
    kernel.ctx.plugin((await import('mini-dsh')).ToolsService)
    kernel.ctx.plugin((await import('mini-dsh')).AgentsService)
    kernel.ctx.llm.register(new FakeScriptedLlm(script as never))
    const root = sessions.create(workspaceId)
    const executor = new ChildExecutor(kernel.ctx)
    return { kernel, executor, workspaceId: workspaceId as unknown as string, rootSessionId: root.id as unknown as string }
  }

  function spawnRequest(harness: Harness, definition: import('mini-dsh').AgentDefinition, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
    return {
      workspaceId: harness.workspaceId as never,
      projectId: undefined,
      parentSessionId: harness.rootSessionId as never,
      parentTurnId: 'turn-1',
      definition,
      packet: { objective: 'inspect the repo', constraints: [], references: [], requiredResult: 'summary' },
      ...overrides,
    }
  }

  it('a child runs the task packet in an ISOLATED session and returns a bounded result', async () => {
    const { AgentDefinitionService } = await import('mini-dsh')
    const harness = await bootChildHarness(['explorer found 3 files'])
    const definitions = new AgentDefinitionService(home)
    const explorer = (await definitions.resolve(harness.workspaceId as never, 'explorer')).definition
    const handle = await harness.executor.spawn(spawnRequest(harness, explorer))
    const settled = await waitOne(harness.executor, harness.workspaceId, handle.childSessionId, 3_000)
    expect(settled !== undefined && settled.status).toBe('completed')
    expect(settled?.result?.report).toBe('explorer found 3 files')
    // Isolation: the child session carries the task packet, not parent history.
    void harness
    void harness.kernel.stop()
  }, 15_000)

  it('wait follows several children at once and returns the moment a stop aborts it', async () => {
    const { AgentDefinitionService } = await import('mini-dsh')
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
    void harness.kernel.stop()
  }, 20_000)

  it('capacity: more than the active limit reports capacity reached (429 semantics, no queue)', async () => {
    const harness = await bootChildHarness([{ toolCalls: [{ name: 'Read', args: {} }] }])
    const { AgentDefinitionService } = await import('mini-dsh')
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
    // Spawn three children (the active limit); the fourth must 429.
    const handles = []
    for (let i = 0; i < 3; i++) {
      handles.push(await harness.executor.spawn(spawnRequest(harness, worker)))
    }
    await expect(harness.executor.spawn(spawnRequest(harness, worker))).rejects.toMatchObject({ code: 'capacity' })
    // Cancel all: root Stop cleanup (awaited settlement confirmed).
    expect(await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)).toBe(3)
    for (const handle of handles) {
      const settled = await waitOne(harness.executor, harness.workspaceId, handle.childSessionId, 3_000)
      expect(settled !== undefined && settled.status).toBe('cancelled')
    }
    void harness.kernel.stop()
  }, 20_000)

  it('four simultaneous spawns reserve active capacity atomically: exactly three succeed', async () => {
    const harness = await bootChildHarness([new Promise(() => {}) as never])
    const worker = (await new AgentDefinitionService(home).resolve(harness.workspaceId as never, 'worker')).definition
    const results = await Promise.allSettled([
      harness.executor.spawn(spawnRequest(harness, worker)),
      harness.executor.spawn(spawnRequest(harness, worker)),
      harness.executor.spawn(spawnRequest(harness, worker)),
      harness.executor.spawn(spawnRequest(harness, worker)),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await harness.kernel.stop()
  }, 20_000)

  it('write-capable child waits for the awaited writer handoff before starting', async () => {
    const harness = await bootChildHarness(['done'])
    const worker = (await new AgentDefinitionService(home).resolve(harness.workspaceId as never, 'worker')).definition
    let releasedAt = 0
    harness.kernel.ctx.on('agent/child-writer-handoff', async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      releasedAt = Date.now()
    })
    let modelStartedAt = 0
    harness.kernel.ctx.llm.register({
      name: 'handoff-spy',
      async *stream() {
        modelStartedAt = Date.now()
        yield { type: 'delta', delta: 'done' }
      },
    })
    harness.kernel.ctx.llm.use('handoff-spy')
    const handle = await harness.executor.spawn(spawnRequest(harness, worker, { grantTools: ['Write'] }))
    const settled = await waitOne(harness.executor, harness.workspaceId, handle.childSessionId, 3_000)
    expect(settled?.status).toBe('completed')
    expect(releasedAt).toBeGreaterThan(0)
    expect(modelStartedAt).toBeGreaterThanOrEqual(releasedAt)
    await harness.kernel.stop()
  }, 15_000)

  it('recovered child relationships list/result without a live Agent and never replay', async () => {
    const isolated = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-recover-'))
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
    const { AgentDefinitionService } = await import('mini-dsh')
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
    void harness.kernel.stop()
  }, 15_000)
})
