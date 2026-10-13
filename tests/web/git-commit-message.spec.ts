/**
 * The AI commit message: Zed's diff compression (long lines, then hunks),
 * the prompt assembly, the staged/unstaged diff choice, and the streaming
 * wrapper (thinking deltas skipped, abort honoured).
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitExecutable, runGitQuery } from '../../src/web/project-git.ts'
import type { StreamEvent } from '../../src/harness/llm/types.ts'
import { commitMessageDiff, commitMessagePrompt, MAX_DIFF_BYTES, streamCommitMessage, truncateDiff } from '../../src/web/git-commit-message.ts'

let scratch = ''
let home = ''
const saved: Record<string, string | undefined> = {}

function git(cwd: string, args: readonly string[], opts: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(gitExecutable() as string, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (opts.allowFailure === true) return ''
    throw error
  }
}

beforeAll(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-commit-msg-')))
  home = path.join(scratch, 'home')
  await fs.mkdir(home)
  await fs.writeFile(path.join(home, '.bash_profile'), '')
  for (const key of ['HOME', 'SHELL']) saved[key] = process.env[key]
  process.env['HOME'] = home
  process.env['SHELL'] = '/bin/bash'
})

afterAll(async () => {
  for (const key of ['HOME', 'SHELL']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await fs.rm(scratch, { recursive: true, force: true })
})

/** One file patch with `hunks` hunks, each about `chunk` bytes of added lines. */
function fileDiff(name: string, hunks: number, chunk: number): string {
  const body = Array.from({ length: Math.ceil(chunk / 80) }, (_, index) => `+${'y'.repeat(79)}`).join('\n')
  const blocks = Array.from({ length: hunks }, (_, index) => `@@ -${index * 10 + 1} +${index * 10 + 1} @@\n${body}`).join('\n')
  return `--- a/${name}\n+++ b/${name}\n${blocks}`
}

/** Hunks kept for a file: its piece runs from its header to the next header (or the end). */
const hunkCount = (diff: string, name: string): number => {
  const piece = (diff.split(`--- a/${name}`)[1] ?? '').split(/\n(?=--- a\/)/)[0] ?? ''
  return piece.split('\n').filter((line) => line.startsWith('@@')).length
}

describe('truncateDiff (Zed compress_commit_diff)', () => {
  it('passes a small diff through unchanged', () => {
    expect(truncateDiff('diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+x\n')).toBe('diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+x\n')
  })

  it('cuts lines longer than 256 bytes at a character boundary (only once over the cap)', () => {
    // Zed compress_commit_diff only rewrites lines when the whole diff is over
    // the cap; a small diff passes through untouched.
    const long = `+${'x'.repeat(300)}`
    const small = `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n${long}\n`
    expect(truncateDiff(small)).toBe(small)
    const filler = `diff --git a/f b/f\n--- a/f\n+++ b/f\n${Array.from({ length: 120 }, (_, index) => `@@ -${index} +${index} @@\n+${'z'.repeat(200)}`).join('\n')}\n`
    const out = truncateDiff(filler + small)
    // The first 256 bytes of the line — '+' plus 255 x's — then the marker.
    expect(out).toContain(`+${'x'.repeat(255)}...[truncated]`)
    expect(out).not.toContain('x'.repeat(256))
  })

  it('drops hunks from the file with the most, keeping at least one, and says how many', () => {
    const big = `${fileDiff('a', 40, 600)}\n${fileDiff('b', 2, 600)}`
    const out = truncateDiff(big)
    expect(hunkCount(out, 'b')).toBe(2)
    expect(hunkCount(out, 'a')).toBeGreaterThanOrEqual(1)
    expect(out).toMatch(/\[\.\.\.skipped \d+ hunks\.\.\.\]\n/)
    expect(Buffer.byteLength(out)).toBeLessThan(Buffer.byteLength(big))
  })

  it('never drops the last hunk of a file: the result may exceed the cap', () => {
    const oneEach = `${fileDiff('a', 1, 30_000)}\n${fileDiff('b', 1, 30_000)}`
    const out = truncateDiff(oneEach)
    expect(hunkCount(out, 'a')).toBe(1)
    expect(hunkCount(out, 'b')).toBe(1)
    expect(Buffer.byteLength(out)).toBeGreaterThan(MAX_DIFF_BYTES)
  })
})

describe('the prompt', () => {
  it('assembles like Zed: text, optional subject, then the changes', () => {
    const prompt = commitMessagePrompt('DIFF', 'Fix thing')
    expect(prompt.startsWith('You are an expert at writing Git commits.')).toBe(true)
    expect(prompt.endsWith('\nHere is the user\'s subject line:\nFix thing\nHere are the changes in this commit:\nDIFF')).toBe(true)
    expect(commitMessagePrompt('DIFF')).not.toContain('subject line:')
  })
})

describe('the diff choice', () => {
  it('uses the staged diff when something is staged, else the unstaged one', async () => {
    const dir = path.join(scratch, 'repo')
    await fs.mkdir(dir)
    const run = (...args: string[]): string => git(dir, args)
    run('init', '-q', '-b', 'main'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't')
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n')
    await fs.writeFile(path.join(dir, 'b.txt'), 'b\n')
    run('add', '.'); run('commit', '-qm', 'init')
    await fs.writeFile(path.join(dir, 'a.txt'), 'a2\n')
    await fs.writeFile(path.join(dir, 'b.txt'), 'b2\n')
    const unstaged = await commitMessageDiff(dir, true)
    expect(unstaged).toContain('+a2')
    expect(unstaged).toContain('+b2')
    run('add', 'a.txt')
    const staged = await commitMessageDiff(dir, true)
    expect(staged).toContain('+a2')
    expect(staged).not.toContain('+b2')
  })
})

describe('streaming', () => {
  it('yields text deltas, skips thinking, and stops reading once aborted', async () => {
    let aborted = false
    let readAfterAbort = false
    const stream = async function* (_request: unknown, signal: AbortSignal): AsyncGenerator<StreamEvent> {
      yield { type: 'delta', delta: 'Add ' }
      yield { type: 'delta', delta: 'thinking…', thinking: true }
      // The wait is armed BEFORE the consumer can abort (an already-aborted
      // signal never fires again), then releases on abort.
      const release = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      yield { type: 'delta', delta: 'x' }
      await release
      aborted = true
      yield { type: 'delta', delta: ' never' }
    }
    const controller = new AbortController()
    const got: string[] = []
    for await (const text of streamCommitMessage(
      { stream: stream as unknown as Parameters<typeof streamCommitMessage>[0]['stream'] },
      { providerName: 'p', model: 'm', prompt: 'P' },
      controller.signal,
    )) {
      got.push(text)
      if (got.length === 2) controller.abort()
    }
    // Text deltas surface, the thinking one does not; the abort releases the
    // provider, but the wrapper stops reading: the post-abort delta never
    // reaches the consumer.
    expect(got).toEqual(['Add ', 'x'])
    expect(aborted).toBe(true)
  })
})
