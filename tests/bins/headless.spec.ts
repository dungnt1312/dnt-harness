/**
 * CLI smoke: without a key the process still boots. A model call then fails
 * because no provider is registered — it must not pretend a mock answered.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { WorkspaceService } from '../../src/harness/workspace/service.ts'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bunExecutable } from '../helpers/runtime-executable.ts'

const binPath = fileURLToPath(new URL('../../src/bins/headless.ts', import.meta.url))

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bunExecutable(), [binPath, ...args], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, DEEPSEEK_API_KEY: '', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

describe('headless CLI', () => {
  let dataDir: string | undefined

  afterEach(async () => {
    if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true })
  })

  it('real CLI provider receives bounded scoped indexes and grants, then loses them when memory is disabled', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'cli-memory-'))
    const workspaces = new WorkspaceService(dataDir)
    await workspaces.boot()
    const ws = workspaces.defaultWorkspace
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const project = await workspaces.createProject(ws, 'CLI project', root)
    const wsRoot = path.join(dataDir, 'workspaces', ws, 'memory', 'workspace')
    const projectRoot = path.join(dataDir, 'workspaces', ws, 'memory', 'projects', project.id)
    for (const dir of [wsRoot, projectRoot]) {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'MEMORY.md'), 'CLI index marker\n' + Array(250).fill('🍀'.repeat(100)).join('\n'))
    }
    const requests: { messages: { content: string }[] }[] = []
    let enabled = true
    const provider = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      requests.push(JSON.parse(raw))
      const first = requests.length === 1 || requests.length === 3
      const delta = first ? { tool_calls: [{ index: 0, id: 'write-memory', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ path: path.join(projectRoot, enabled ? 'cli.md' : 'disabled.md'), content: 'CLI wrote memory' }) } }] } : { content: 'done' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as { port: number }
    const env = { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}` }
    try {
      const result = await runCli(['--data-dir', dataDir, '--config', path.join(dataDir, 'providers.json'), '--root', root, '--yolo', '--message', 'remember'], env)
      expect(result.code).toBe(0)
      const context = requests[0]!.messages.map((message) => message.content).join('\n')
      expect(context).toContain(wsRoot)
      expect(context).toContain(projectRoot)
      expect(context).toContain('<untrusted kind="memory"')
      expect(context).toContain('WARNING: MEMORY.md was truncated')
      expect(context).toContain('Do not store secrets')
      expect(await readFile(path.join(projectRoot, 'cli.md'), 'utf8')).toBe('CLI wrote memory')
      enabled = false
      const modes = path.join(dataDir, 'workspaces', ws, 'modes')
      await mkdir(modes, { recursive: true })
      await writeFile(path.join(modes, 'no-memory.md'), '---\nname: No memory\nmemoryPinned: false\nmemoryRetrieval: false\n---\n\nMemory disabled.\n')
      await writeFile(path.join(modes, '.selected.json'), JSON.stringify({ selected: 'no-memory' }))
      const disabled = await runCli(['--data-dir', dataDir, '--config', path.join(dataDir, 'providers.json'), '--root', root, '--yolo', '--message', 'again'], env)
      expect(disabled.code).toBe(0)
      expect(requests[2]!.messages.map((message) => message.content).join('\n')).not.toContain('CLI index marker')
      await expect(readFile(path.join(projectRoot, 'disabled.md'))).rejects.toThrow()
      expect(disabled.stdout).toContain('tool✗')
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
    }
  }, 30_000)

  it('calibrates the next request by the provider-reported input of the previous one, like the web host', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'cli-calibration-'))
    const root = fileURLToPath(new URL('../../', import.meta.url))
    let calls = 0
    const provider = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      calls += 1
      const first = calls === 1
      const delta = first
        ? { tool_calls: [{ index: 0, id: 'glob-call', type: 'function', function: { name: 'Glob', arguments: JSON.stringify({ pattern: 'package.json' }) } }] }
        : { content: 'done' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // A report far above the estimate: the ratio clamps to its maximum.
      const usage = { prompt_tokens: 10_000_000, completion_tokens: 5 }
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as { port: number }
    try {
      const result = await runCli(['--data-dir', dataDir, '--config', path.join(dataDir, 'providers.json'), '--root', root, '--yolo', '--message', 'look'], {
        DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      })
      expect(result.code).toBe(0)
      expect(calls).toBe(2)
      const logs = (await readdir(dataDir, { recursive: true })).filter((file) => file.endsWith('events.jsonl') && file.includes(`${path.sep}sessions${path.sep}`))
      expect(logs).toHaveLength(1)
      const events = (await readFile(path.join(dataDir, logs[0]!), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
      const manifests = events.filter((event) => event.type === 'context/manifest').map((event) => event.manifest)
      expect(manifests).toHaveLength(2)
      expect(manifests[0].budget.measured.source).toBe('estimate')
      expect(manifests[1].budget.measured).toMatchObject({ source: 'provider_usage', baseContextId: manifests[0].contextId, ratio: 3 })
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
    }
  }, 30_000)

  it('applies Dangerous Commands even under --yolo: a deny preset blocks the Bash call', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'cli-guard-'))
    const victim = path.join(dataDir, 'victim')
    await mkdir(victim, { recursive: true })
    await writeFile(path.join(victim, 'keep.txt'), 'still here')
    const root = fileURLToPath(new URL('../../', import.meta.url))
    let calls = 0
    const provider = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      calls += 1
      const first = calls === 1
      const delta = first
        ? { tool_calls: [{ index: 0, id: 'rm-call', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: `rm -rf ${victim}` }) } }] }
        : { content: 'done' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as { port: number }
    try {
      const result = await runCli(['--data-dir', dataDir, '--config', path.join(dataDir, 'providers.json'), '--root', root, '--yolo', '--message', 'clean up'], {
        DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('blocked by Dangerous Commands')
      expect(await readFile(path.join(victim, 'keep.txt'), 'utf8')).toBe('still here')
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
    }
  }, 30_000)

  it('starts without DEEPSEEK_API_KEY and does not fall back to a mock provider', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'dnt-harness-headless-'))
    const { code, stdout, stderr } = await runCli(['--data-dir', dataDir, '--config', path.join(dataDir, 'providers.json'), '--message', 'hello'])

    expect(code).toBe(0)
    expect(stderr).toContain('no DEEPSEEK_API_KEY')
    expect(stderr).not.toContain('mock provider')
    expect(stdout).toContain('no provider registered')
    expect(stdout).not.toContain('mock')
  }, 30_000)

  describe('model selection', () => {
    /** A store entry pointing at a fake OpenAI-compatible gateway. */
    async function writeStore(configFile: string, baseUrl: string, options: { model?: string; defaults?: boolean } = {}): Promise<void> {
      const model = options.model ?? 'deepseek-v4.1-flash-free'
      await writeFile(configFile, JSON.stringify({
        version: 2,
        defaults: options.defaults === true ? { provider: 'fake', model, thinkingLevel: null } : { provider: null, model: null, thinkingLevel: null },
        providers: [{ id: 'fake', name: 'fake', baseUrl: `${baseUrl}/v1`, apiKey: '', models: [model], enabled: true }],
        aliases: [],
        aliasGeneration: 0,
      }))
    }

    async function sessionEvents(dir: string): Promise<Record<string, any>[]> {
      const logs = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('events.jsonl') && file.includes(`${path.sep}sessions${path.sep}`))
      return (await readFile(path.join(dir, logs[0]!), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
    }

    it('--provider/--model/--thinking reach the wire and the durable log', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-select-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const bodies: Record<string, unknown>[] = []
      const headers: Record<string, unknown>[] = []
      const provider = createServer(async (req, res) => {
        let raw = ''
        for await (const chunk of req) raw += chunk
        bodies.push(JSON.parse(raw) as Record<string, unknown>)
        headers.push(req.headers)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
      const address = provider.address() as { port: number }
      const config = path.join(dataDir, 'providers.json')
      await writeStore(config, `http://127.0.0.1:${address.port}`)
      try {
        const result = await runCli([
          '--data-dir', dataDir, '--config', config, '--root', root, '--yolo', '--message', 'hi',
          '--provider', 'fake', '--model', 'deepseek-v4.1-flash-free', '--thinking', 'high',
        ])
        expect(result.code).toBe(0)
        expect(bodies[0]?.['model']).toBe('deepseek-v4.1-flash-free')
        // The level must reach the wire, not stop at the settings layer.
        expect(bodies[0]?.['reasoning_effort']).toBe('high')
        const events = await sessionEvents(dataDir)
        // One stable affinity for the conversation: its own session id.
        const sessionId = events.find((event) => typeof event['sessionId'] === 'string')?.['sessionId'] as string | undefined
        expect(headers[0]?.['x-session-affinity']).toBeTypeOf('string')
        if (sessionId !== undefined) expect(headers[0]?.['x-session-affinity']).toBe(sessionId)
        expect(events.find((event) => event.type === 'assistant/message')?.controls).toEqual({ model: 'deepseek-v4.1-flash-free', provider: 'fake' })
      } finally {
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
      }
    }, 30_000)

    it('without flags the provider store decides the pair, and provider/model sugar works', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-defaults-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const models: unknown[] = []
      const provider = createServer(async (req, res) => {
        let raw = ''
        for await (const chunk of req) raw += chunk
        models.push((JSON.parse(raw) as Record<string, unknown>)['model'])
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
      const address = provider.address() as { port: number }
      const config = path.join(dataDir, 'providers.json')
      await writeStore(config, `http://127.0.0.1:${address.port}`, { model: 'stored-model', defaults: true })
      try {
        const stored = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--yolo', '--message', 'one'])
        expect(stored.code).toBe(0)
        expect(models[0]).toBe('stored-model')
        // `--model <provider>/<model>` is resolved against the store.
        const sugar = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--yolo', '--message', 'two', '--model', 'fake/stored-model'])
        expect(sugar.code).toBe(0)
        expect(models[1]).toBe('stored-model')
        expect(sugar.stderr).not.toContain('no provider selected')
      } finally {
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
      }
    }, 30_000)

    it('refuses a thinking level the selected model cannot express', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-thinking-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const config = path.join(dataDir, 'providers.json')
      await writeStore(config, 'http://127.0.0.1:1', { model: 'mystery-model' })
      const unknown = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--thinking', 'bogus'])
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toContain('--thinking must be one of')

      const unsupported = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--model', 'mystery-model', '--thinking', 'high'])
      expect(unsupported.code).toBe(1)
      expect(unsupported.stderr).toContain("cannot express thinking level 'high'")
      // The rejected flag never opened a session or touched the data home.
      expect((await readdir(dataDir, { recursive: true })).filter((file) => file.endsWith('events.jsonl'))).toHaveLength(0)
    }, 30_000)

    it('refuses an unknown or disabled provider and a selection flag with no value, before touching the data home', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-bad-provider-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const config = path.join(dataDir, 'providers.json')
      await writeFile(config, JSON.stringify({
        version: 2,
        defaults: { provider: null, model: null, thinkingLevel: null },
        providers: [
          { id: 'fake', name: 'fake', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', models: ['m'], enabled: true },
          { id: 'off', name: 'off', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', models: ['m'], enabled: false },
        ],
        aliases: [],
        aliasGeneration: 0,
      }))
      const unknown = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--provider', 'nope'])
      expect(unknown.code).toBe(1)
      expect(unknown.stderr).toContain("provider 'nope' is not configured or not enabled (available: fake)")

      const disabled = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--provider', 'off'])
      expect(disabled.code).toBe(1)
      expect(disabled.stderr).toContain("provider 'off' is not configured or not enabled")

      const missing = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--model'])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain('--model needs a value')

      // A following flag is not a value: no model `--yolo`, no silent yolo.
      const swallowed = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--model', '--yolo'])
      expect(swallowed.code).toBe(1)
      expect(swallowed.stderr).toContain('--model needs a value')

      // Like the web host, a model the provider does not advertise is refused.
      const unknownModel = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--provider', 'fake', '--model', 'nope'])
      expect(unknownModel.code).toBe(1)
      expect(unknownModel.stderr).toContain("unknown model 'nope' for provider 'fake'; available: m")
      expect((await readdir(dataDir, { recursive: true })).filter((file) => file.endsWith('events.jsonl'))).toHaveLength(0)
    }, 30_000)

    it('a disabled deepseek entry is the operator decision: the env key does not bring it back', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-disabled-deepseek-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const config = path.join(dataDir, 'providers.json')
      // Written with a UTF-8 BOM, as Windows editors do: still a valid store.
      await writeFile(config, '\uFEFF' + JSON.stringify({
        version: 2,
        defaults: { provider: null, model: null, thinkingLevel: null },
        providers: [
          { id: 'fake', name: 'fake', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', models: ['m'], enabled: true },
          { id: 'deepseek', name: 'deepseek', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', models: ['deepseek-flash'], enabled: false },
        ],
        aliases: [],
        aliasGeneration: 0,
      }))
      const result = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi', '--provider', 'deepseek'], { DEEPSEEK_API_KEY: 'sk-env' })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("provider 'deepseek' is not configured or not enabled (available: fake)")
      expect(result.stderr).not.toContain('could not be parsed')
    }, 30_000)

    it('names an unreadable provider config instead of reporting none configured', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-corrupt-store-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const config = path.join(dataDir, 'providers.json')
      await writeFile(config, '{ not json')
      const result = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--message', 'hi'])
      expect(result.stderr).toContain(`provider config '${config}' could not be parsed`)
    }, 30_000)

    it('PH1-A: per-model context 32768 / output 4096 drive the manifest budget and the wire cap (phase-04 shared resolver)', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-effective-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const bodies: Record<string, unknown>[] = []
      const provider = createServer(async (req, res) => {
        let raw = ''
        for await (const chunk of req) raw += chunk
        bodies.push(JSON.parse(raw) as Record<string, unknown>)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
      const address = provider.address() as { port: number }
      const config = path.join(dataDir, 'providers.json')
      await writeFile(config, JSON.stringify({
        version: 2,
        defaults: { provider: 'fake', model: 'custom-model', thinkingLevel: null },
        providers: [{ id: 'fake', name: 'fake', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: '', models: ['custom-model'], enabled: true, modelSettings: { 'custom-model': { contextTokens: 32_768, maxOutputTokens: 4_096 } } }],
        aliases: [],
        aliasGeneration: 0,
      }))
      try {
        const result = await runCli(['--data-dir', dataDir, '--config', config, '--root', root, '--yolo', '--message', 'hi'])
        expect(result.code).toBe(0)
        expect(bodies[0]?.['max_tokens']).toBe(4_096)
        const manifest = (await sessionEvents(dataDir)).find((event) => event.type === 'context/manifest')?.manifest
        expect(manifest.budget).toMatchObject({ contextLimitTokens: 32_768, windowSource: 'override' })
      } finally {
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
      }
    }, 30_000)

    it('legacy DEEPSEEK_API_KEY alone selects deepseek-flash, so --thinking works with no store', async () => {
      dataDir = await mkdtemp(path.join(tmpdir(), 'cli-legacy-'))
      const root = fileURLToPath(new URL('../../', import.meta.url))
      const bodies: Record<string, unknown>[] = []
      const provider = createServer(async (req, res) => {
        let raw = ''
        for await (const chunk of req) raw += chunk
        bodies.push(JSON.parse(raw) as Record<string, unknown>)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
      const address = provider.address() as { port: number }
      try {
        const result = await runCli(
          ['--data-dir', dataDir, '--config', path.join(dataDir, 'providers.json'), '--root', root, '--yolo', '--message', 'hi', '--thinking', 'high'],
          { DEEPSEEK_API_KEY: 'sk-test-legacy', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}` },
        )
        expect(result.code).toBe(0)
        expect(result.stderr).not.toContain('no model selected')
        expect(bodies[0]?.['model']).toBe('deepseek-flash')
        expect(bodies[0]?.['reasoning_effort']).toBe('high')
      } finally {
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
      }
    }, 30_000)
  })
})
