/**
 * The bash tool: captured output, exit-code reporting, non-zero exits,
 * timeout kill with process cleanup, spawn-failure settling, disabled
 * environments with actionable errors, and stop cancellation.
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bashTool, DEFAULT_LIMITS, fsTools, Kernel, ToolsService, type LimitsSnapshot, type ToolExecution } from 'dnt-harness'
import { sweepByTag, TREE_TAG_ENV } from '../../src/capabilities/shell/bash.ts'
import { darwinShellOptions, detectLoginShell, detectShell, shellCatalog } from '../../src/capabilities/shell/detect.ts'

const exec: ToolExecution = { root: process.cwd() }

describe('no harness-added file-tool hints', () => {
  it('leaves the output unchanged for cat/rg/ls/leading cd/heredoc commands', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-bash-hint-'))
    try {
      await fs.writeFile(path.join(root, 'a.txt'), 'hello', 'utf8')
      const run = (command: string) => bashTool().execute({ command }, { root, toolCallId: 'toolu_1' })
      expect(await run('cat a.txt')).toBe('hello\n[exit code: 0]')
      expect(await run('ls')).toBe('a.txt\n\n[exit code: 0]')
      expect(await run(`cd "${root}" && cat a.txt`)).toBe('hello\n[exit code: 0]')
      expect(await run("cat > b.txt <<'EOF'\nx\nEOF")).toBe('\n[exit code: 0]')
      expect(await run('grep -rn hello . || true')).not.toContain('[hint:')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  it('keeps a [hint: …] line the program itself prints', async () => {
    const out = await bashTool().execute({ command: "printf '[hint: x]\\n'" }, { root: process.cwd(), toolCallId: 'toolu_1' })
    expect(out).toBe('[hint: x]\n\n[exit code: 0]')
  })
  it('steers file reads/searches to the file tools and states the observation rule', () => {
    const description = bashTool().description
    expect(description).toMatch(/reading a file through Bash creates no observation/)
    expect(description).toMatch(/do not use Bash to read, search or change file contents \(`cat`, `head`, `tail`, `sed`/)
    expect(description).toMatch(/Read \(any line range\)/)
  })
})

describe('bash tool', () => {
  it('captures combined stdout/stderr and appends the exit code', async () => {
    const output = await bashTool().execute({ command: 'echo out; echo err 1>&2; true' }, exec)
    expect(output).toContain('out')
    expect(output).toContain('err')
    expect(output).toContain('[exit code: 0]')
  })

  it('uses the execution root over a configured cwd, matching filesystem tools', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-bash-root-'))
    const fallback = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-bash-fallback-'))
    try {
      await fs.writeFile(path.join(root, 'marker.txt'), 'project root', 'utf8')
      await fs.writeFile(path.join(fallback, 'marker.txt'), 'fallback root', 'utf8')
      const execution = { ...exec, root }
      const read = fsTools().find((tool) => tool.name === 'Read')
      expect(read).toBeDefined()
      await expect(read!.execute({ path: 'marker.txt' }, execution)).resolves.toBe('1\tproject root')
      const output = await bashTool({ cwd: fallback }).execute({ command: 'cat marker.txt' }, execution)
      expect(output).toContain('project root')
      expect(output).not.toContain('fallback root')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(fallback, { recursive: true, force: true })
    }
  })

  it('fails closed through the root-aware pipeline when no root is granted', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.tools.register(bashTool())
    await expect(kernel.ctx.tools.execute({ id: 'unbound-bash', name: 'Bash', args: { command: 'echo escaped' } }))
      .resolves.toEqual({
        ok: false,
        output: "denied: no workspace root is granted for 'Bash'; grant one before running root-aware tools",
      })
  })

  it('reports a non-zero exit code in the suffix', async () => {
    const output = await bashTool({ timeoutMs: 5_000 }).execute({ command: 'exit 3' }, exec)
    expect(output).toContain('[exit code: 3]')
  })

  it('uses the configured default when timeoutMs is zero or negative', async () => {
    const tool = bashTool({ timeoutMs: 2_000 })
    await expect(tool.execute({ command: 'echo zero', timeoutMs: 0 }, exec)).resolves.toContain('zero')
    await expect(tool.execute({ command: 'echo negative', timeoutMs: -1 }, exec)).resolves.toContain('negative')
  })

  it('kills a command that exceeds the timeout and settles quickly', async () => {
    const start = Date.now()
    const output = await bashTool({ timeoutMs: 300 }).execute({ command: 'sleep 5; echo never' }, exec)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(3_000)
    expect(output).not.toContain('never')
    expect(output).toContain('[terminated by timeout; killed]')
  }, 10_000)

  it('the shell stays usable after a timeout kill (no stuck pipes or orphans)', async () => {
    await bashTool({ timeoutMs: 200 }).execute({ command: 'sleep 4' }, exec)
    const after = await bashTool({ timeoutMs: 5_000 }).execute({ command: 'echo alive' }, exec)
    expect(after).toContain('alive')
  }, 15_000)

  it('a stop signal terminates the command and the result is marked cancelled', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const start = Date.now()
    const output = await bashTool({ timeoutMs: 30_000 }).execute(
      { command: 'sleep 5; echo never' },
      { ...exec, signal: controller.signal },
    )
    expect(Date.now() - start).toBeLessThan(3_000)
    expect(output).toContain('[terminated by stop; killed]')
    expect(output).not.toContain('never')
  }, 10_000)

  it('a spawn failure settles the call with an actionable error instead of hanging', async () => {
    // An existing but non-executable file: the spawn itself fails.
    const notExecutable = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname'
    const output = await bashTool({ executable: notExecutable, timeoutMs: 3_000 }).execute(
      { command: 'echo never' },
      exec,
    )
    expect(output).toMatch(/spawn failed|not available/)
    expect(output).not.toContain('never')
  }, 10_000)

  it('an explicitly missing executable disables the tool with an actionable error', async () => {
    const output = await bashTool({ executable: 'Z:\\nowhere\\bash.exe' }).execute({ command: 'echo hi' }, exec)
    expect(output).toContain('bash is not available')
    expect(output).toContain('DNT_HARNESS_BASH')
  })

  it('a non-string command argument fails loud', async () => {
    await expect(bashTool().execute({ command: 42 }, exec)).rejects.toThrow(/non-empty string/)
  })

  it('the timeout kills the whole tree: an orphaned subshell never writes its marker', async () => {
    // The background subshell is a grandchild. If the tree kill missed it,
    // it would touch marker.txt ~2s after the parent shell died.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-orphan-marker-'))
    const output = await bashTool({ timeoutMs: 300 }).execute(
      { command: '( sleep 2 && touch escaped-marker.txt ) & wait' },
      { ...exec, root },
    )
    expect(output).not.toContain('never')
    await new Promise((resolve) => setTimeout(resolve, 2_600))
    let markerExists = false
    try {
      await fs.access(path.join(root, 'escaped-marker.txt'))
      markerExists = true
    } catch {
      markerExists = false
    }
    await fs.rm(root, { recursive: true, force: true })
    expect(markerExists).toBe(false)
  }, 10_000)

  it('labels the interactive shell Bash on POSIX and Git Bash on Windows', () => {
    const bash = shellCatalog().find((option) => option.id === 'bash')
    expect(bash).toBeDefined()
    expect(bash!.label).toBe(process.platform === 'win32' ? 'Git Bash' : 'Bash')
  })

  it('leads the macOS catalog with the login shell and still offers the other one', () => {
    if (process.platform !== 'darwin') return
    const catalog = shellCatalog()
    const login = detectLoginShell().executable ?? ''
    const lead = login.endsWith('/bash') ? 'bash' : 'zsh'
    expect(catalog[0]?.id).toBe(lead)
    expect(catalog.map((option) => option.id).sort()).toEqual(['bash', 'zsh'])
  })

  it('resolves the zsh option to an existing executable started as a login shell on macOS only', () => {
    const zsh = shellCatalog().find((option) => option.id === 'zsh')
    if (process.platform !== 'darwin') {
      expect(zsh).toBeUndefined()
      return
    }
    expect(zsh).toBeDefined()
    expect(existsSync(zsh!.executable)).toBe(true)
    expect(zsh!.args).toEqual(['-l', '-i'])
  })

  it('starts the macOS login shell like Terminal.app: first, by its exact path, as a login shell', () => {
    expect(darwinShellOptions('/opt/homebrew/bin/zsh', '/bin/bash')).toEqual([
      { id: 'zsh', label: 'zsh', executable: '/opt/homebrew/bin/zsh', args: ['-l', '-i'] },
      { id: 'bash', label: 'Bash', executable: '/bin/bash', args: ['-l', '-i'] },
    ])
    expect(darwinShellOptions('/opt/homebrew/bin/bash', '/bin/bash').map((option) => [option.id, option.executable])).toEqual([
      ['bash', '/opt/homebrew/bin/bash'],
      ['zsh', existsSync('/bin/zsh') ? '/bin/zsh' : 'zsh'],
    ])
    // DNT_HARNESS_BASH pins bash explicitly: the login path only decides the order.
    expect(darwinShellOptions('/opt/homebrew/bin/bash', '/custom/bash', true)[0]).toMatchObject({ id: 'bash', executable: '/custom/bash' })
    // Login shell unknown or something else (fish): zsh, the macOS default, leads.
    expect(darwinShellOptions(undefined, '/bin/bash').map((option) => option.id)).toEqual(['zsh', 'bash'])
    expect(darwinShellOptions('/opt/homebrew/bin/fish', undefined).map((option) => option.id)).toEqual(['zsh'])
  })

  it('keeps the Linux interactive shell a non-login bash', () => {
    if (process.platform !== 'linux') return
    expect(shellCatalog()).toEqual([expect.objectContaining({ id: 'bash', args: ['-i'] })])
  })

  it.runIf(process.platform === 'win32')('the tag sweep alone kills a tagged tree whose root no walk can reach', async () => {
    // Models the orphan taskkill /T misses: nothing here walks a tree, so
    // only the environment-tag sweep can stop these processes.
    const { spawn } = await import('node:child_process')
    const shell = detectShell().executable
    expect(shell).toBeDefined()
    const tag = `sweep-test-${process.pid}-${Date.now()}`
    const tree = spawn(shell as string, ['-c', 'sleep 30 & sleep 30 & wait'], {
      env: { ...process.env, [TREE_TAG_ENV]: tag },
      stdio: 'ignore',
    })
    const exited = new Promise<void>((resolve) => tree.once('exit', () => resolve()))
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      spawn(shell as string, ['-c', sweepByTag(tag)], { stdio: 'ignore', windowsHide: true })
      const outcome = await Promise.race([
        exited.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('alive'), 6_000)),
      ])
      expect(outcome).toBe('exited')
    } finally {
      if (tree.exitCode === null && tree.pid !== undefined) {
        spawn('taskkill', ['/pid', String(tree.pid), '/T', '/F'], { stdio: 'ignore' })
      }
    }
  }, 15_000)

  it('a firehose command is bounded at the configured output limit', async () => {
    const tool = bashTool({ timeoutMs: 15_000 })
    const output = await tool.execute({ command: 'yes spam | head -c 400000' }, { ...exec, outputLimit: 2_000 })
    expect(output.length).toBeLessThan(4_000)
    expect(output).toMatch(/truncated/)
  }, 20_000)

  it('schema and execution read the current limits', async () => {
    let snapshot: LimitsSnapshot = Object.freeze({ revision: 0, values: DEFAULT_LIMITS })
    const tool = bashTool({ limits: { read: () => snapshot }, timeoutMs: 5_000 })
    const waitDescription = (): string => (tool.schema?.()?.parameters.properties['timeoutMs'] as { description: string }).description
    expect(waitDescription()).toContain('default 120000, max 600000')

    snapshot = Object.freeze({ revision: 1, values: Object.freeze({ ...DEFAULT_LIMITS, toolTimeoutMs: 100, bashMaxWaitMs: 200 }) })
    expect(waitDescription()).toContain('default 100, max 200')

    // The clamp is taken once at start: a later publication does not re-time it.
    let started = Date.now()
    const running = tool.execute({ command: 'sleep 5; echo never' }, exec)
    snapshot = Object.freeze({ revision: 2, values: Object.freeze({ ...DEFAULT_LIMITS, toolTimeoutMs: 60_000, bashMaxWaitMs: 60_000 }) })
    let output = await running
    expect(output).toContain('[terminated by timeout; killed]')
    expect(output).not.toContain('never')
    expect(Date.now() - started).toBeLessThan(3_000)

    // An explicit argument above the current maximum clamps to it.
    snapshot = Object.freeze({ revision: 3, values: Object.freeze({ ...DEFAULT_LIMITS, toolTimeoutMs: 100, bashMaxWaitMs: 200 }) })
    started = Date.now()
    output = await tool.execute({ command: 'sleep 5; echo never', timeoutMs: 60_000 }, exec)
    expect(output).toContain('[terminated by timeout; killed]')
    expect(output).not.toContain('never')
    expect(Date.now() - started).toBeLessThan(3_000)

    // A trusted execution snapshot outranks the reader.
    snapshot = Object.freeze({ revision: 4, values: DEFAULT_LIMITS })
    started = Date.now()
    output = await tool.execute({ command: 'sleep 5; echo never' }, { ...exec, limitsSnapshot: Object.freeze({ revision: 5, values: Object.freeze({ ...DEFAULT_LIMITS, toolTimeoutMs: 100 }) }) })
    expect(output).toContain('[terminated by timeout; killed]')
    expect(output).not.toContain('never')
    expect(Date.now() - started).toBeLessThan(3_000)
  }, 20_000)

  it('a fixed-option Bash keeps its configured timeout through the tool pipeline', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.tools.setRootResolver(() => ({ root: process.cwd() }))
    kernel.ctx.tools.register(bashTool({ timeoutMs: 200 }))
    try {
      const started = Date.now()
      const result = await kernel.ctx.tools.execute({ id: 'fixed', name: 'Bash', args: { command: 'sleep 5; echo never' } })
      expect(result.output).toContain('[terminated by timeout; killed]')
      expect(result.output).not.toContain('never')
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      await kernel.stop()
    }
  }, 10_000)

  it('static callers keep their configured wait budget and schema', async () => {
    const tool = bashTool({ timeoutMs: 2_000 })
    const description = (tool.parameters.properties['timeoutMs'] as { description: string }).description
    expect(description).toContain('default 2000, max 600000')
    expect(tool.schema).toBeUndefined()
    const output = await bashTool({ timeoutMs: 100 }).execute({ command: 'sleep 5; echo never' }, exec)
    expect(output).toContain('[terminated by timeout; killed]')
    expect(output).not.toContain('never')
  }, 10_000)
})
