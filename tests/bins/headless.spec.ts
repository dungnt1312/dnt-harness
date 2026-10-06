/**
 * CLI smoke: without a key the process still boots. A model call then fails
 * because no provider is registered — it must not pretend a mock answered.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { WorkspaceService } from '../../src/harness/workspace/service.ts'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const binPath = fileURLToPath(new URL('../../src/bins/headless.ts', import.meta.url))

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', binPath, ...args], {
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
      const result = await runCli(['--data-dir', dataDir, '--root', root, '--yolo', '--message', 'remember'], env)
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
      const disabled = await runCli(['--data-dir', dataDir, '--root', root, '--yolo', '--message', 'again'], env)
      expect(disabled.code).toBe(0)
      expect(requests[2]!.messages.map((message) => message.content).join('\n')).not.toContain('CLI index marker')
      await expect(readFile(path.join(projectRoot, 'disabled.md'))).rejects.toThrow()
      expect(disabled.stdout).toContain('tool✗')
    } finally {
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()))
    }
  }, 30_000)

  it('starts without DEEPSEEK_API_KEY and does not fall back to a mock provider', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'dnt-harness-headless-'))
    const { code, stdout, stderr } = await runCli(['--data-dir', dataDir, '--message', 'hello'])

    expect(code).toBe(0)
    expect(stderr).toContain('no DEEPSEEK_API_KEY')
    expect(stderr).not.toContain('mock provider')
    expect(stdout).toContain('no provider registered')
    expect(stdout).not.toContain('mock')
  }, 30_000)
})
