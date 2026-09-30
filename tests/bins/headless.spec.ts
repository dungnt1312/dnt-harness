/**
 * CLI smoke: without a key the process still boots. A model call then fails
 * because no provider is registered — it must not pretend a mock answered.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const binPath = fileURLToPath(new URL('../../src/bins/headless.ts', import.meta.url))

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', binPath, ...args], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, DEEPSEEK_API_KEY: '' },
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

  it('starts without DEEPSEEK_API_KEY and does not fall back to a mock provider', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mini-dsh-headless-'))
    const { code, stdout, stderr } = await runCli(['--data-dir', dataDir, '--message', 'hello'])

    expect(code).toBe(0)
    expect(stderr).toContain('no DEEPSEEK_API_KEY')
    expect(stderr).not.toContain('mock provider')
    expect(stdout).toContain('no provider registered')
    expect(stdout).not.toContain('mock')
  }, 30_000)
})
