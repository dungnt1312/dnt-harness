/**
 * RH3-A / RH3-C actual-process gate, run from Vitest on Linux. The probes
 * themselves live in scripts/pty-probes.mjs because they must run under Bun
 * (Bun's built-in PTY), not Vitest's Node workers. Real bash, real signals.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bunExecutable } from '../helpers/runtime-executable.ts'

describe('terminal teardown with real processes (Linux)', () => {
  it.skipIf(process.platform !== 'linux')('passes every pty probe under Bun', () => {
    const script = fileURLToPath(new URL('../../scripts/pty-probes.mjs', import.meta.url))
    const run = spawnSync(bunExecutable(), [script, '--require'], { encoding: 'utf8', timeout: 180_000 })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    expect(run.status, output).toBe(0)
    expect(output).not.toMatch(/^FAIL /m)
  }, 200_000)
})
