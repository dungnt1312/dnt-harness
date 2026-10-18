/**
 * Actual-process terminal gate, run from Vitest on Linux and macOS. The probes
 * themselves live in scripts/pty-probes.mjs because they must run under Bun
 * (Bun's built-in PTY), not Vitest's Node workers. Real shells, real signals.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bunExecutable } from '../helpers/runtime-executable.ts'

const posix = process.platform === 'linux' || process.platform === 'darwin'
const hasZsh = existsSync('/bin/zsh') || existsSync('/usr/bin/zsh')

describe('terminal teardown with real processes (Linux, macOS)', () => {
  for (const shell of ['bash', 'zsh'] as const) {
    // macOS always ships zsh (its default shell); Linux hosts may not.
    const run = posix && (shell === 'bash' || hasZsh)
    it.runIf(run)(`passes every pty probe under Bun with ${shell}`, () => {
      const script = fileURLToPath(new URL('../../scripts/pty-probes.mjs', import.meta.url))
      const probe = spawnSync(bunExecutable(), [script, '--require', '--shell', shell], { encoding: 'utf8', timeout: 180_000 })
      const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
      expect(probe.status, output).toBe(0)
      expect(output).not.toMatch(/^FAIL /m)
    }, 200_000)
  }
})
