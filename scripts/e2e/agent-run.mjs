// Agent process runner + per-contestant run/check flow for the benchmark.
// Extracted from compare-opencode-dnt.mjs so the error/timeout/drift paths can
// be tested with fake agents.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  RepoSafetyError,
  buildDisposableCopy,
  compareFingerprints,
  describeDrift,
  diffManifests,
  sourceFingerprint,
  targetManifest,
  verifyDisposableCopy,
} from './repo-freeze.mjs'

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

/** Kills the whole process tree rooted at `child` (best effort, synchronous). */
export function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    spawnSync(path.join(system32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') try { child.kill('SIGKILL') } catch {}
    }
  }
}

/**
 * Runs a command; on timeout kills its whole process tree. Resolves with
 * { code, ms, stdout, stderr, timedOut }, never rejects.
 */
export function runProcess(cmd, cmdArgs, options = {}) {
  const { timeoutMs = 300_000, ...spawnOptions } = options
  return new Promise((resolve) => {
    const started = Date.now()
    const out = []
    const err = []
    let timedOut = false
    let settled = false
    const finish = (code, extra = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        ms: Date.now() - started,
        timedOut,
        stdout: stripAnsi(Buffer.concat(out).toString('utf8')),
        stderr: `${stripAnsi(Buffer.concat(err).toString('utf8'))}${extra}`,
      })
    }
    const child = spawn(cmd, cmdArgs, {
      ...spawnOptions,
      // POSIX: own process group so the whole tree can be signalled.
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // Grandchildren holding the pipes must not keep us waiting forever.
      setTimeout(() => finish(child.exitCode ?? -1, `\n[timed out after ${timeoutMs}ms; process tree killed]`), 5_000).unref()
    }, timeoutMs)
    child.on('close', (code) => finish(timedOut ? (code ?? -1) : code, timedOut ? `\n[timed out after ${timeoutMs}ms; process tree killed]` : ''))
    // A failed spawn emits 'error' and may never emit 'close'.
    child.on('error', (error) => finish(-1, String(error)))
  })
}

/**
 * One contestant run: build + verify a fresh copy (or use a disposable
 * target), run the agent, then report drift on the target and on the source.
 * Never restores anything; the target is left in place for inspection.
 *
 * @param {object} o
 * @param {object|null} o.snapshot frozen source (repo-copy/lab) or null (--repo)
 * @param {string} [o.targetDir] fresh directory for the copy, or the disposable target
 * @param {string} o.registry disposable registry path
 * @param {object|null} [o.sourceBefore] source fingerprint to re-check
 * @param {string} [o.sourceRoot]
 * @param {(target: string) => Promise<object>} o.launch
 */
export async function runContestant({ snapshot, targetDir, registry, sourceBefore = null, sourceRoot, launch }) {
  let target = targetDir
  if (snapshot) {
    try {
      buildDisposableCopy(snapshot, targetDir, registry)
      verifyDisposableCopy(snapshot, targetDir)
    } catch (error) {
      const message = error instanceof RepoSafetyError ? error.message : String(error)
      return {
        result: { code: -1, ms: 0, timedOut: false, stdout: '', stderr: message },
        drift: [`copy failed before any agent ran: ${message}`],
        sourceChanged: [],
        target: targetDir,
        ran: false,
      }
    }
  }
  const before = targetManifest(target)
  let result
  try {
    result = await launch(target)
  } catch (error) {
    result = { code: -1, ms: 0, timedOut: false, stdout: '', stderr: String(error) }
  }
  const drift = describeDrift(diffManifests(before, targetManifest(target)))
  const sourceChanged = sourceBefore && sourceRoot ? compareFingerprints(sourceBefore, sourceFingerprint(sourceRoot)) : []
  if (sourceChanged.length > 0) drift.push(`source repository changed: ${sourceChanged.join(', ')}`)
  return { result, drift, sourceChanged, target, ran: true }
}

/** A run fails on nonzero/timeout exit, missing ground truth or any drift. */
export function runFailed(entry, missing = []) {
  return entry.result.code !== 0 || entry.result.timedOut === true || missing.length > 0 || entry.drift.length > 0
}
