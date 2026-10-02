/**
 * The bash tool: captured output, exit-code reporting, non-zero exits,
 * timeout kill with process cleanup, spawn-failure settling, disabled
 * environments with actionable errors, and stop cancellation.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bashTool, fsTools, Kernel, ToolsService, type ToolExecution } from 'mini-dsh'
import { sweepByTag, TREE_TAG_ENV } from '../../src/capabilities/shell/bash.ts'
import { detectShell } from '../../src/capabilities/shell/detect.ts'

const exec: ToolExecution = { root: process.cwd() }

describe('bash tool', () => {
  it('captures combined stdout/stderr and appends the exit code', async () => {
    const output = await bashTool().execute({ command: 'echo out; echo err 1>&2; true' }, exec)
    expect(output).toContain('out')
    expect(output).toContain('err')
    expect(output).toContain('[exit code: 0]')
  })

  it('uses the execution root over a configured cwd, matching filesystem tools', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-bash-root-'))
    const fallback = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-bash-fallback-'))
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
        output: "no workspace root is granted for 'Bash'; grant one before running root-aware tools",
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
    expect(output).toContain('MINI_DSH_BASH')
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
    const root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-orphan-marker-'))
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
})
