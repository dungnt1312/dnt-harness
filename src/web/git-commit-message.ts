/**
 * The AI commit message (a port of Zed `generate_commit_message`): the diff
 * input, Zed's compression (`compress_commit_diff`), the prompt assembly and
 * the streaming wrapper the server route drives.
 */
import { readFileSync } from 'node:fs'
import { runGitQuery } from './project-git.ts'
import type { ModelRequest, StreamEvent } from '../harness/llm/types.ts'

export const MAX_DIFF_BYTES = 20_000

const PROMPT = readFileSync(new URL('./git-commit-message-prompt.txt', import.meta.url), 'utf8').trimEnd()

// ── Zed compress_commit_diff (git_panel.rs:4155-4180, 1053-1113) ──

/** One file patch of a unified diff: its two header lines and its hunks. */
interface TruncatedPatch {
  readonly header: string
  readonly hunks: readonly string[]
  hunksToKeep: number
}

function splitPatch(patch: string): string[] {
  const result: string[] = []
  let current = ''
  for (const line of patch.split('\n')) {
    if (line.startsWith('---') && current !== '') {
      result.push(current.replace(/\n+$/, ''))
      current = ''
    }
    current += `${line}\n`
  }
  if (current.replace(/\n+$/, '') !== '') result.push(current.replace(/\n+$/, ''))
  return result
}

function parseTruncatedPatch(patch: string): TruncatedPatch | null {
  const lines = patch.split('\n')
  if (lines.length < 2) return null
  const header = `${lines[0]}\n${lines[1]}\n`
  const hunks: string[] = []
  let current = ''
  for (const line of lines.slice(2)) {
    if (line.startsWith('@@')) {
      if (current !== '') hunks.push(current)
      current = `${line}\n`
    } else if (current !== '') {
      current += `${line}\n`
    }
  }
  if (current !== '') hunks.push(current)
  if (hunks.length === 0) return null
  return { header, hunks, hunksToKeep: hunks.length }
}

function sizeOf(patch: TruncatedPatch): number {
  let size = patch.header.length
  for (let index = 0; index < patch.hunksToKeep; index++) size += patch.hunks[index]?.length ?? 0
  return size
}

function truncateIteratively(patch: string, maxBytes: number): string {
  let currentSize = Buffer.byteLength(patch)
  if (currentSize <= maxBytes) return patch
  const infos = splitPatch(patch)
    .map(parseTruncatedPatch)
    .filter((info): info is TruncatedPatch => info !== null)
  if (infos.length === 0) return patch
  currentSize = infos.reduce((sum, info) => sum + sizeOf(info), 0)
  while (currentSize > maxBytes) {
    // Rust `max_by_key` returns the LAST maximum.
    let chosen = -1
    let best = -1
    for (let index = 0; index < infos.length; index++) {
      const info = infos[index]!
      if (info.hunksToKeep > 1 && info.hunksToKeep >= best) { best = info.hunksToKeep; chosen = index }
    }
    if (chosen === -1) break
    const before = sizeOf(infos[chosen]!)
    infos[chosen]!.hunksToKeep -= 1
    currentSize -= before - sizeOf(infos[chosen]!)
  }
  return infos.map((info) => {
    let out = info.header
    for (let index = 0; index < info.hunksToKeep; index++) out += info.hunks[index]
    const skipped = info.hunks.length - info.hunksToKeep
    if (skipped > 0) out += `[...skipped ${skipped} hunks...]\n`
    return out
  }).join('\n')
}

/** Zed `compress_commit_diff`: cut long lines, then drop hunks from the file with the most. */
export function truncateDiff(diff: string): string {
  if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return diff
  // 256 bytes, never splitting a character.
  let compressed = Buffer.from(diff, 'utf8').toString('utf8').split('\n').map((line) => {
    const bytes = Buffer.from(line, 'utf8')
    if (bytes.length <= 256) return `${line}\n`
    // Rust keeps the first 256 bytes (`floor_char_boundary`): back off while
    // the byte at the cut is a UTF-8 continuation byte.
    let cut = 256
    while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--
    return `${bytes.subarray(0, cut).toString('utf8')}...[truncated]\n`
  }).join('')
  if (Buffer.byteLength(compressed) <= MAX_DIFF_BYTES) return compressed
  compressed = truncateIteratively(compressed, MAX_DIFF_BYTES)
  return compressed
}

// ── the request ──────────────────────────────────────────────────

/** The staged diff when anything is staged, else the unstaged one (untracked excluded), compressed. */
export async function commitMessageDiff(root: string, trusted: boolean): Promise<string> {
  const stagedEmpty = await runGitQuery(root, ['diff', '--cached', '--quiet'], trusted)
  const diff = await runGitQuery(root, stagedEmpty.code === 0
    ? ['diff', '--no-color']
    : ['diff', '--no-color', '--cached'], trusted)
  return truncateDiff(diff.stdout.toString('utf8'))
}

/** The prompt: Zed's text, the optional subject line, then the changes. */
export function commitMessagePrompt(diff: string, subject?: string): string {
  const subjectPart = subject !== undefined && subject !== '' ? `\nHere is the user's subject line:\n${subject}` : ''
  return `${PROMPT}${subjectPart}\nHere are the changes in this commit:\n${diff}`
}

/**
 * Stream the message: one user message, no tools, no thinking override. Only
 * text deltas surface; a `thinking` delta never does. The signal aborts the
 * provider stream, as a client disconnect must.
 */
export async function* streamCommitMessage(
  deps: { stream: (request: ModelRequest, signal: AbortSignal) => AsyncIterable<StreamEvent> },
  request: { providerName: string; model: string; prompt: string },
  signal: AbortSignal,
  onUsage?: (usage: { inputTokens: number; cachedInputTokens?: number; outputTokens?: number }) => void,
): AsyncGenerator<string> {
  for await (const event of deps.stream({
    providerName: request.providerName,
    model: request.model,
    messages: [{ role: 'user', content: request.prompt }],
  }, signal)) {
    if (signal.aborted) return
    if (event.type === 'delta' && event.thinking !== true) yield event.delta
    else if (event.type === 'usage') onUsage?.(event.usage)
  }
}
